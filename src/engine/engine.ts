// Transport-agnostic funnel engine (Section 5, 6). Consumes normalized comment/message events
// from EITHER the poller or the webhook route and advances each person's state machine. All
// side-effects (DMs, public actions) run idempotently via the ledgers, so re-polls and webhook
// retries never double-message anyone.

import type { InstagramClient } from "../api/client";
import type { SendQueue } from "../queue/queue";
import type {
  Campaign,
  EventType,
  NormalizedComment,
  NormalizedMessage,
  State,
} from "../types";
import { InstagramApiError } from "../api/client";
import { commentTriggers, extractEmail } from "./match";
import {
  FOLLOW_PAYLOAD,
  OPENING_PAYLOAD,
  afterFollow,
  afterTap,
  confirmsFollow,
  emailReasksExhausted,
  followGateReasksExhausted,
  parsePayload,
  taggedPayload,
} from "./transitions";
import {
  claimCommentAction,
  claimSend,
  createConversation,
  getActiveCampaigns,
  getCampaign,
  getConversation,
  getOpenConversations,
  isCommentProcessed,
  logEvent,
  markCommentProcessed,
  releaseSend,
  updateConversation,
} from "../db";
import type { ConversationRow } from "../db";

// The gate is a nudge, not a check — nothing verifies the follow (no Instagram API can). The copy
// carries all of the persuasion, which is why the button stays worded as an attestation: tapping
// something that says "I followed" prompts people to actually go and follow first. A neutral label
// like "Send me the resource" delivers exactly the same reward while asking nothing of them.
const DEFAULT_FOLLOW_GATE =
  "Make sure you're following so you don't miss the next one 🙌 Not following yet? Follow, then tap below.";
const DEFAULT_FOLLOW_BUTTON = "✅ I followed";

/**
 * Instagram caps a postback button's visible title at 20 characters and rejects the whole send if
 * it is longer. That rejection is definitive, so the opening would be retried on every poll
 * forever without ever succeeding — a permanent hot loop, and a lead that never gets its DM.
 *
 * The builder now stops you typing past the limit, but campaigns imported from config.json or
 * saved before that check existed can still carry a long label, so trim defensively here. Losing
 * the tail of a label is plainly better than the message never arriving.
 */
const MAX_BUTTON_TITLE = 20;

/**
 * `raw` is typed as a string, but campaigns arriving through /config/import or written straight
 * into the campaigns table are not guaranteed to honour that — and a non-string here used to throw
 * TypeError on .trim(), which (see pollComments) aborted the whole tick for everyone behind it.
 * Anything that isn't a usable string falls back to the default label instead.
 */
function buttonTitle(raw: unknown, fallback: string): string {
  const candidate = typeof raw === "string" ? raw.trim() : "";
  const title = candidate || fallback;
  if (title.length <= MAX_BUTTON_TITLE) return title;
  console.warn(`[chatmany] button label "${title}" exceeds ${MAX_BUTTON_TITLE} chars; trimming so Instagram accepts the send.`);
  return trimToLength(title, MAX_BUTTON_TITLE);
}

/**
 * Trim to at most `max` UTF-16 units WITHOUT splitting a character.
 *
 * A plain .slice() counts UTF-16 units, so it happily cuts an emoji's surrogate pair in half —
 * "xxxxxxxxxxxxxxxxxxx🙌".slice(0, 20) ends in a lone \ud83d, which is not valid text and is not
 * something to hand to Instagram. Iterating the string yields whole code points, so we only ever
 * stop on a character boundary.
 */
function trimToLength(s: string, max: number): string {
  let out = "";
  for (const ch of s) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

/** Deterministic rotation through public-reply variants so it looks human. */
function pickRotating(texts: string[], seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return texts[h % texts.length]!;
}

export class Engine {
  constructor(
    private readonly db: D1Database,
    private readonly client: InstagramClient,
    private readonly queue: SendQueue,
  ) {}

  // ---- comments ----

  /**
   * Handle a new comment: trigger match → public actions → opening DM. Idempotent per comment.
   * `activeCampaigns` may be passed by the poller (already fetched) to avoid a DB read per comment;
   * the webhook path omits it and we fetch on demand.
   */
  async handleComment(evt: NormalizedComment, activeCampaigns?: Campaign[]): Promise<void> {
    if (await isCommentProcessed(this.db, evt.comment_id)) return;
    if (!evt.igsid) return; // cannot correlate future messages without the commenter's IGSID

    const all = activeCampaigns ?? (await getActiveCampaigns(this.db));
    const campaigns = all.filter((c) => c.media_id === evt.media_id);
    let matchedCampaignId = "-";
    // A retryable opening-send failure leaves the comment unprocessed so the next poll retries it.
    let pendingRetry = false;

    for (const campaign of campaigns) {
      if (!commentTriggers(evt.text, campaign.keywords, campaign.exclude)) continue;
      matchedCampaignId = campaign.campaign_id;

      // Public actions are per-comment (independent toggles), guarded so re-polls don't repeat them.
      await this.runPublicActions(campaign, evt);

      // Dedup DM: multiple comments from one person = exactly one opening DM per campaign.
      const existing = await getConversation(this.db, evt.igsid, campaign.campaign_id);
      if (existing) continue;

      // New lead: comment_matched + opening_sent are logged only when the opening actually sends,
      // so a failed send neither inflates the funnel nor is double-counted on the retry.
      const sent = await this.sendOpening(campaign, evt);
      if (!sent) pendingRetry = true;
    }

    // Mark processed once nothing is awaiting retry, so we don't re-scan this comment every poll.
    if (!pendingRetry) await markCommentProcessed(this.db, evt.comment_id, evt.igsid, matchedCampaignId);
  }

  private async runPublicActions(campaign: Campaign, evt: NormalizedComment): Promise<void> {
    if (campaign.public_reply?.enabled && campaign.public_reply.texts.length > 0) {
      if (await claimCommentAction(this.db, evt.comment_id, "public_reply")) {
        const text = pickRotating(campaign.public_reply.texts, evt.comment_id);
        await this.trySend(() => this.client.replyToComment(evt.comment_id, text), "public_reply");
      }
    }
    // `like_comment` is intentionally not acted on: Instagram's API has no way to like a comment
    // (see the note in api/client.ts). The field is still accepted so older saved campaigns keep
    // loading, but it does nothing.
  }

  /**
   * Open the chat via a private reply to the comment, using a postback button (Step 1).
   * Returns true if the opening was sent and the funnel entry recorded; false on a send failure
   * (so the caller leaves the comment unprocessed for a retry on the next poll).
   */
  private async sendOpening(campaign: Campaign, evt: NormalizedComment): Promise<boolean> {
    const button = {
      type: "postback" as const,
      title: buttonTitle(campaign.copy.opening_button, "Continue"),
      payload: taggedPayload(OPENING_PAYLOAD, campaign.campaign_id),
    };
    const ok = await this.trySend(
      () => this.client.privateReplyWithButtons(evt.comment_id, campaign.copy.opening, [button]),
      "opening",
      `opening:${campaign.campaign_id}:${evt.comment_id}`,
    );
    if (!ok) return false;
    await createConversation(this.db, evt.igsid, campaign.campaign_id, evt.username ?? null, "AWAITING_TAP");
    await logEvent(this.db, campaign.campaign_id, "comment_matched", evt.igsid);
    await logEvent(this.db, campaign.campaign_id, "opening_sent", evt.igsid);
    return true;
  }

  // ---- messages ----

  /**
   * Handle an inbound message: advance any of this person's open conversations. In polling mode
   * the hidden payload is often unavailable, so taps are resolved by matching the message text to
   * the expected button title for the current state (and, for AWAITING_TAP, any inbound message
   * counts — the opening postback posts no visible text; webhook mode also delivers the payload).
   */
  async handleMessage(evt: NormalizedMessage): Promise<void> {
    const open = await getOpenConversations(this.db, evt.igsid);

    // If the press identifies which campaign's button it was, only that funnel advances. Everything
    // else — a typed reply, or a legacy untagged button still sitting in someone's inbox — carries
    // no such information, so it falls back to advancing every open funnel as before. That fallback
    // is why someone with two funnels open still completes both by typing "ok": the message simply
    // does not say which one they meant, and there is nothing to infer it from.
    const { campaignId: tapped } = parsePayload(evt.payload);
    const targets = tapped ? open.filter((c) => c.campaign_id === tapped) : open;

    for (const convo of targets) {
      // Idempotency: only act on a message that arrived after our last transition, so re-reads of
      // the same message in the conversation history don't advance the funnel twice.
      if (evt.timestamp <= convo.updated_at) continue;

      const campaign = await getCampaign(this.db, convo.campaign_id);
      if (!campaign) continue;

      switch (convo.state as State) {
        case "AWAITING_TAP":
          await this.onTap(campaign, evt);
          break;
        case "AWAITING_FOLLOW":
          await this.onFollow(campaign, evt, convo.follow_retries);
          break;
        case "AWAITING_EMAIL":
          await this.onEmail(campaign, evt, convo.email_retries);
          break;
        default:
          break; // NEW / DELIVER / DONE — nothing to do
      }
    }
  }

  private async onTap(campaign: Campaign, evt: NormalizedMessage): Promise<void> {
    // Any inbound message (or an explicit OPENING_TAP payload) counts as the tap. The
    // button_clicked event is logged inside enterState, only once the next message actually sends,
    // so a failed send leaves the tap message unconsumed (updated_at unchanged) for a clean retry.
    await this.enterState(campaign, evt.igsid, afterTap(campaign), { entryEvent: "button_clicked" });
  }

  private async onFollow(campaign: Campaign, evt: NormalizedMessage, gateReasks: number): Promise<void> {
    if (!confirmsFollow(evt)) {
      // Not the gate button. If it was OUR opening button — a button template, so it sits in the
      // transcript forever and is easy to scroll up and re-press — put the gate back at the bottom
      // of the thread rather than answering a deliberate press with silence. Any other button's
      // payload is someone else's event and must not cross-advance, so it stays ignored.
      const { kind } = parsePayload(evt.payload);
      if (kind === OPENING_PAYLOAD) await this.resendFollowGate(campaign, evt.igsid, gateReasks);
      return; // either way, stay in AWAITING_FOLLOW
    }

    await this.enterState(campaign, evt.igsid, afterFollow(campaign), {
      entryEvent: "follow_confirmed",
      patch: { followed: 1 },
    });
  }

  /**
   * Re-send the follow gate to someone who pressed the wrong button, capped.
   *
   * Deliberately claim-free (like resendEmailAsk): the first gate's send claim is still held, so
   * reusing sendFollowGate here would be skipped as "already attempted" and send nothing at all.
   * The counter is only bumped once the re-send actually goes out, so a failed send retries
   * cleanly instead of silently spending one of the two allowed nudges.
   */
  private async resendFollowGate(campaign: Campaign, igsid: string, reasks: number): Promise<void> {
    if (followGateReasksExhausted(reasks)) {
      console.warn(`[chatmany] follow-gate re-send cap reached for ${igsid} on ${campaign.campaign_id}; staying quiet.`);
      return;
    }
    const button = {
      type: "postback" as const,
      title: buttonTitle(campaign.copy.follow_button, DEFAULT_FOLLOW_BUTTON),
      payload: taggedPayload(FOLLOW_PAYLOAD, campaign.campaign_id),
    };
    const ok = await this.trySend(
      () => this.client.sendButtonTemplate({ igsid }, campaign.copy.follow_gate ?? DEFAULT_FOLLOW_GATE, [button]),
      "follow_gate_resend",
    );
    if (ok) {
      await updateConversation(this.db, igsid, campaign.campaign_id, {
        state: "AWAITING_FOLLOW",
        follow_retries: reasks + 1,
      });
    }
  }

  private async onEmail(campaign: Campaign, evt: NormalizedMessage, reasks: number): Promise<void> {
    const email = evt.email ?? extractEmail(evt.text);
    if (!email) {
      // Not a valid email (no @ / not chip-provided) — re-ask instead of silently ignoring it,
      // so the person gets a nudge rather than the bot going quiet. Resource is never sent from here.
      await this.resendEmailAsk(campaign, evt.igsid, reasks);
      return;
    }
    await this.enterState(campaign, evt.igsid, "DELIVER", { entryEvent: "email_captured", patch: { email } });
  }

  /**
   * Nudge someone who replied with something that isn't an email — but only a couple of times.
   *
   * Uncapped, this re-asked on every non-email reply, so somebody who simply kept talking got one
   * more DM per message; a photo, sticker or voice note counts too, since those arrive with no text
   * at all. Repeatedly DMing a person who is not engaging is what platform spam detection watches
   * for, so the risk lands on the sending account, not just the reader's patience.
   *
   * Hitting the cap only stops the nudging. The conversation stays in AWAITING_EMAIL, so an address
   * sent later is still captured and still delivers the reward.
   */
  private async resendEmailAsk(campaign: Campaign, igsid: string, reasks: number): Promise<void> {
    if (emailReasksExhausted(reasks)) {
      console.warn(`[chatmany] email re-ask cap reached for ${igsid} on ${campaign.campaign_id}; staying quiet.`);
      return;
    }
    const ok = await this.trySend(
      () =>
        this.client.sendQuickReplies(
          igsid,
          campaign.copy.email_ask ?? "Tap your email or reply with it 👇",
          [{ content_type: "user_email" }],
        ),
      "email_ask_resend",
    );
    // Only mark the invalid-reply message as handled once the re-ask actually sent — same
    // fail-clean pattern as every other send: a failed resend leaves updated_at untouched so the
    // same message retries cleanly on the next poll instead of being silently dropped.
    if (ok) {
      await updateConversation(this.db, igsid, campaign.campaign_id, {
        state: "AWAITING_EMAIL",
        email_retries: reasks + 1,
      });
    }
  }

  /**
   * Enter a target state: perform the outbound send first, then — only if it succeeded — persist
   * the new state together with any field patch and log the entry event, in that single write. A
   * failed send changes nothing (no state, no updated_at bump, no event), so the triggering message
   * re-fires on the next poll and the entry event is never double-counted. DELIVER collapses to DONE.
   */
  private async enterState(
    campaign: Campaign,
    igsid: string,
    target: State,
    opts: { entryEvent?: EventType; patch?: Partial<Pick<ConversationRow, "email" | "followed">> } = {},
  ): Promise<void> {
    const commit = async (restingState: State, extra?: EventType) => {
      await updateConversation(this.db, igsid, campaign.campaign_id, { state: restingState, ...opts.patch });
      if (opts.entryEvent) await logEvent(this.db, campaign.campaign_id, opts.entryEvent, igsid);
      if (extra) await logEvent(this.db, campaign.campaign_id, extra, igsid);
    };

    switch (target) {
      case "AWAITING_FOLLOW": {
        const ok = await this.sendFollowGate(campaign, igsid);
        if (!ok) return;
        await commit("AWAITING_FOLLOW");
        break;
      }
      case "AWAITING_EMAIL": {
        const ok = await this.trySend(
          () =>
            this.client.sendQuickReplies(
              igsid,
              campaign.copy.email_ask ?? "Tap your email or reply with it 👇",
              [{ content_type: "user_email" }],
            ),
          "email_ask",
          `email_ask:${campaign.campaign_id}:${igsid}`,
        );
        if (!ok) return;
        await commit("AWAITING_EMAIL");
        break;
      }
      case "DELIVER": {
        const text = campaign.copy.delivery.replaceAll("{reward}", campaign.reward.value);
        const ok = await this.trySend(
          () => this.client.sendText(igsid, text),
          "delivery",
          `delivery:${campaign.campaign_id}:${igsid}`,
        );
        if (!ok) return;
        await commit("DONE", "delivered");
        break;
      }
      default:
        await commit(target);
    }
  }

  /**
   * Send the follow gate as a button-template message — the same shape as the opening DM, and for
   * the same reason: it stays in the transcript. The quick-reply chips this replaced were dropped
   * by Instagram as soon as the person typed, left, or returned to the thread, leaving them in
   * AWAITING_FOLLOW with nothing to tap.
   */
  private async sendFollowGate(campaign: Campaign, igsid: string): Promise<boolean> {
    const button = {
      type: "postback" as const,
      title: buttonTitle(campaign.copy.follow_button, DEFAULT_FOLLOW_BUTTON),
      payload: taggedPayload(FOLLOW_PAYLOAD, campaign.campaign_id),
    };
    return this.trySend(
      () =>
        this.client.sendButtonTemplate({ igsid }, campaign.copy.follow_gate ?? DEFAULT_FOLLOW_GATE, [button]),
      "follow_gate",
      `follow_gate:${campaign.campaign_id}:${igsid}`,
    );
  }

  // ---- send helpers ----

  /**
   * Run a send through the queue, at most once per `key`.
   *
   * Sends are claimed before they go out. The outcome of a failed send is not always knowable:
   * a timeout, dropped connection, or 5xx can all arrive *after* Instagram already delivered the
   * message. Treating those as "never happened" and retrying is what shows a person the same DM
   * twice, so instead:
   *
   *   - the platform answered with an error (any HTTP status) → the request reached Instagram and
   *     was rejected, so nothing was delivered: release the claim and report failure so the caller
   *     retries cleanly on the next poll;
   *   - no answer at all (network error, timeout, dropped connection) → we never learned the
   *     outcome and it may well have landed, so keep the claim and report success, advancing the
   *     funnel rather than risking a duplicate;
   *   - claim already held → a previous attempt got far enough to send, so skip and report
   *     success. This is what catches a retry after the Worker died mid-send.
   *
   * The trade is deliberate: at-most-once delivery. A genuinely lost message leaves that person
   * where they were instead of being messaged again.
   */
  private async trySend<T>(fn: () => Promise<T>, label: string, key?: string): Promise<boolean> {
    const claimKey = key ?? null;
    if (claimKey && !(await claimSend(this.db, claimKey))) {
      console.warn(`[chatmany] skipping ${label}: already attempted, may have delivered (${claimKey})`);
      return true;
    }
    try {
      await this.queue.run(fn);
      return true;
    } catch (e) {
      // An InstagramApiError means we received an HTTP response — the request reached Instagram
      // and was refused, so nothing went out. Anything else (fetch threw, timeout, socket closed)
      // means we never learned the outcome, and the message may already be in the person's inbox.
      const rejected = e instanceof InstagramApiError;
      if (rejected) {
        if (claimKey) await releaseSend(this.db, claimKey);
        console.warn(`[chatmany] send failed (${label}), will retry: ${msg(e)}`);
        return false;
      }
      console.warn(
        `[chatmany] send outcome unknown (${label}): ${msg(e)} — treating as delivered so it is not sent twice`,
      );
      return claimKey ? true : false;
    }
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

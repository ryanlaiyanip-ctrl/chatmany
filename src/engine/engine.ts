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
  confirmsTap,
  emailReasksExhausted,
  mayReplyTo,
  followGateReasksExhausted,
  parsePayload,
  taggedPayload,
  tapReasksExhausted,
} from "./transitions";
import {
  claimCommentAction,
  claimSend,
  createConversation,
  getActiveCampaigns,
  getCampaign,
  getConversation,
  getAllConversations,
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

/**
 * How far along the funnel each waiting state is. Used to decide which of several open funnels a
 * payload-less message most plausibly belongs to.
 */
const FUNNEL_DEPTH: Record<string, number> = { AWAITING_EMAIL: 3, AWAITING_FOLLOW: 2, AWAITING_TAP: 1 };

/**
 * Order the funnels a payload-less message could belong to, most plausible first.
 *
 * Deepest first: if someone has one funnel waiting on a tap and another waiting on an email, a
 * typed address is obviously meant for the email step — taking them in table order would let the
 * tap funnel consume the message as a nudge and waste the address. Ties break on the most recently
 * created funnel, which is the post they commented on most recently and so the one they are most
 * likely to be asking about.
 *
 * A tagged press never reaches this: it names its campaign, so there is exactly one target.
 */
function inReplyOrder(convos: ConversationRow[]): ConversationRow[] {
  return [...convos].sort(
    (a, b) =>
      (FUNNEL_DEPTH[b.state] ?? 0) - (FUNNEL_DEPTH[a.state] ?? 0) || b.created_at - a.created_at,
  );
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

  /**
   * Is this the text ECHO of one of our own buttons, rather than something the person typed?
   *
   * Pressing a postback button does not only deliver a postback — Instagram also posts the button's
   * label into the thread as a message from that person. Look at any real transcript: the user's
   * side shows a bubble reading "Send it to me" or "✅ I followed" that they never typed. So ONE
   * press arrives as TWO inbound events: the postback carrying the payload, and this echo carrying
   * only the label.
   *
   * Requiring the payload made the echo actively harmful. The postback advances the funnel, and
   * then the echo — payload-less, and therefore "a typed reply" by the new rule — draws a re-send
   * of the button they just pressed. That is the duplicate follow gate people were seeing, twice
   * over when the poller re-read the same echo underneath the webhook.
   *
   * It is worse than cosmetic. Whichever copy lands first stamps updated_at, and the idempotency
   * guard drops anything at or before that. When the echo wins the race it nudges AND buries the
   * real press, so the person has to press a second time to get anywhere — exactly what the
   * "pressed ✅ I followed twice" transcript shows.
   *
   * So an echo is ignored outright: no advance, no nudge, and deliberately no updated_at bump, so
   * the postback copy still counts whenever it arrives. Someone who genuinely types the label by
   * hand is ignored too, which costs nothing — their press, if they make one, still works.
   *
   * Matched against the labels of EVERY funnel this person has open, not just the one being
   * examined. The echo is a thread-level event and names no campaign, so checking it per campaign
   * meant pressing video 2's button was an echo to video 2 and a "typed reply" to video 1 — which
   * nudged video 1 and burned one of its re-sends off a press that had nothing to do with it. That
   * stayed invisible while every campaign shared the same button text, and would have appeared the
   * moment one campaign's label was edited in the builder.
   */
  private isButtonEcho(evt: NormalizedMessage, ourLabels: Set<string>): boolean {
    if (evt.payload) return false; // carries a payload: this IS the press, not its echo
    const text = evt.text?.trim();
    if (!text) return false;
    return ourLabels.has(text);
  }

  // ---- messages ----

  /**
   * Handle an inbound message: advance any of this person's open conversations.
   *
   * A button press is proven by its postback payload and nothing else. AWAITING_TAP and
   * AWAITING_FOLLOW both used to advance on any inbound message, a rule inherited from polling
   * mode (which never surfaces a payload) — but once a webhook callback is registered, a real
   * press always carries one and a typed message never does, so that rule just pulled people who
   * had not pressed anything through the funnel. A reply that is not a press now gets the button
   * it ignored re-sent, capped, and leaves the state where it was.
   */
  async handleMessage(evt: NormalizedMessage): Promise<void> {
    // Every funnel, finished ones included: the open ones are what a message can advance, but the
    // finished ones still contribute button labels (their buttons remain in the transcript, and a
    // press on one still echoes).
    const all = await getAllConversations(this.db, evt.igsid);
    const open = all.filter((c) => c.state !== "DONE");

    // If the press identifies which campaign's button it was, only that funnel is considered.
    // Everything else — a typed reply, or a legacy untagged button still sitting in someone's inbox
    // — names no campaign, so every open funnel is considered instead. That is a wider net, not a
    // looser rule: each funnel still requires a real press to advance, so a typed "ok" reaching all
    // of them advances none of them. The only thing the net changes is which funnel gets to answer,
    // which is what inReplyOrder and the one-nudge budget below decide.
    const { campaignId: tapped } = parsePayload(evt.payload);
    const targets = tapped ? open.filter((c) => c.campaign_id === tapped) : open;

    /**
     * AT MOST ONE NUDGE PER INBOUND MESSAGE.
     *
     * Every campaign shares ONE Instagram DM thread with a person. Someone who comments on two
     * posts without pressing anything has two funnels open in that single thread, so nudging per
     * conversation meant one typed "hey" produced two button DMs back to back — and with three
     * campaigns, three. That is the same fan-out that used to fire a reward per funnel, just moved
     * from rewards to re-sends, and it is precisely the burst pattern the per-conversation caps
     * exist to prevent (those caps bound each funnel separately, which bounds nothing in a thread
     * holding several).
     *
     * A nudge is us reacting to something that was NOT a signal, so it is the least justified send
     * we make: one per message is plenty. Real progress — an email arriving, a tagged press — is
     * earned by the person's own action and stays unrestricted.
     */
    // Fetched up front so the echo check below sees the labels of EVERY funnel this person has,
    // not just the ones a message could advance. Scoped by `all` rather than `targets` for two
    // reasons, each of which produced a spurious nudge in testing: a tagged press narrows targets
    // to one campaign, and a finished funnel is not in `open` at all — yet both still have buttons
    // sitting in the transcript that echo when pressed.
    const campaigns = new Map<string, Campaign>();
    const ourLabels = new Set<string>();
    for (const convo of all) {
      const campaign = await getCampaign(this.db, convo.campaign_id);
      if (!campaign) continue;
      campaigns.set(convo.campaign_id, campaign);
      ourLabels.add(buttonTitle(campaign.copy.opening_button, "Continue"));
      ourLabels.add(buttonTitle(campaign.copy.follow_button, DEFAULT_FOLLOW_BUTTON));
    }
    // The label echo of a press. It is one thread event, so it is dropped for the whole message
    // rather than per funnel — and before any state is read, so it can neither nudge nor stamp
    // updated_at over the real press.
    if (this.isButtonEcho(evt, ourLabels)) return;

    let nudged = false;

    for (const convo of inReplyOrder(targets)) {
      // Idempotency: only act on a message that arrived after our last transition, so re-reads of
      // the same message in the conversation history don't advance the funnel twice.
      if (evt.timestamp <= convo.updated_at) continue;

      const campaign = campaigns.get(convo.campaign_id);
      if (!campaign) continue;

      switch (convo.state as State) {
        case "AWAITING_TAP":
          if (await this.onTap(campaign, evt, convo.tap_retries, !nudged)) nudged = true;
          break;
        case "AWAITING_FOLLOW":
          if (await this.onFollow(campaign, evt, convo.follow_retries, !nudged)) nudged = true;
          break;
        case "AWAITING_EMAIL":
          if (await this.onEmail(campaign, evt, convo.email_retries, !nudged)) nudged = true;
          break;
        default:
          break; // NEW / DELIVER / DONE — nothing to do
      }
    }
  }

  /** Returns true if this consumed the message's one allowed nudge. */
  private async onTap(
    campaign: Campaign,
    evt: NormalizedMessage,
    tapReasks: number,
    mayNudge: boolean,
  ): Promise<boolean> {
    if (!confirmsTap(evt)) {
      // Not our opening button, so not a click and never counted as one. A typed reply or a press
      // of our own gate button gets the opening put back at the bottom of the thread rather than
      // silence; a FOREIGN button's payload is someone else's event and earns no send at all.
      if (mayNudge && mayReplyTo(evt)) return this.resendOpening(campaign, evt.igsid, tapReasks);
      return false; // stay in AWAITING_TAP
    }
    // The button_clicked event is logged inside enterState, only once the next message actually
    // sends, so a failed send leaves the tap message unconsumed (updated_at unchanged) for a
    // clean retry.
    await this.enterState(campaign, evt.igsid, afterTap(campaign), { entryEvent: "button_clicked" });
    return false; // an advance is progress, not a nudge
  }

  /**
   * Re-send the opening button to someone who replied in AWAITING_TAP without pressing it, capped.
   *
   * Claim-free and claimed-on-the-current-counter for exactly the reasons spelled out on
   * resendFollowGate: the original opening's send claim is still held, and keying the claim on the
   * counter's current value means two replies arriving at once contend for one key instead of each
   * sending their own nudge. The counter is bumped only once the re-send actually goes out.
   *
   * Note this goes to the IGSID as a normal button template, NOT as a private reply to the comment
   * — Instagram allows a private reply to a given comment exactly once, so re-using that path here
   * would be rejected outright (error 10903).
   */
  private async resendOpening(campaign: Campaign, igsid: string, reasks: number): Promise<boolean> {
    if (tapReasksExhausted(reasks)) {
      console.warn(`[chatmany] opening re-send cap reached for ${igsid} on ${campaign.campaign_id}; staying quiet.`);
      return false;
    }
    const button = {
      type: "postback" as const,
      title: buttonTitle(campaign.copy.opening_button, "Continue"),
      payload: taggedPayload(OPENING_PAYLOAD, campaign.campaign_id),
    };
    const ok = await this.trySend(
      () => this.client.sendButtonTemplate({ igsid }, campaign.copy.opening, [button]),
      "opening_resend",
      `opening_resend:${campaign.campaign_id}:${igsid}:${reasks}`,
    );
    if (ok) {
      await updateConversation(this.db, igsid, campaign.campaign_id, {
        state: "AWAITING_TAP",
        tap_retries: reasks + 1,
      });
    }
    return ok;
  }

  /** Returns true if this consumed the message's one allowed nudge. */
  private async onFollow(
    campaign: Campaign,
    evt: NormalizedMessage,
    gateReasks: number,
    mayNudge: boolean,
  ): Promise<boolean> {
    if (!confirmsFollow(evt)) {
      // Not the gate button. That now covers a typed reply as well as a re-press of our opening
      // button (a button template sits in the transcript forever and is easy to scroll up and hit
      // again), and both deserve the same answer: put the gate back at the bottom of the thread,
      // capped, rather than responding with silence.
      //
      // The one thing that must stay ignored is SOMEONE ELSE'S button payload — a foreign postback
      // is another integration's event and must never make us send anything.
      if (mayNudge && mayReplyTo(evt)) return this.resendFollowGate(campaign, evt.igsid, gateReasks);
      return false; // either way, stay in AWAITING_FOLLOW
    }

    await this.enterState(campaign, evt.igsid, afterFollow(campaign), {
      entryEvent: "follow_confirmed",
      patch: { followed: 1 },
    });
    return false;
  }

  /**
   * Re-send the follow gate to someone who pressed the wrong button, capped.
   *
   * Deliberately claim-free (like resendEmailAsk): the first gate's send claim is still held, so
   * reusing sendFollowGate here would be skipped as "already attempted" and send nothing at all.
   * The counter is only bumped once the re-send actually goes out, so a failed send retries
   * cleanly instead of silently spending one of the two allowed nudges.
   */
  private async resendFollowGate(campaign: Campaign, igsid: string, reasks: number): Promise<boolean> {
    if (followGateReasksExhausted(reasks)) {
      console.warn(`[chatmany] follow-gate re-send cap reached for ${igsid} on ${campaign.campaign_id}; staying quiet.`);
      return false;
    }
    const button = {
      type: "postback" as const,
      title: buttonTitle(campaign.copy.follow_button, DEFAULT_FOLLOW_BUTTON),
      payload: taggedPayload(FOLLOW_PAYLOAD, campaign.campaign_id),
    };
    // Claimed on the counter's CURRENT value, so two presses arriving at once contend for the same
    // key and exactly one of them sends. Without this both read reasks=0, both send, and both write
    // 1 — the cap still terminates, but it lets through roughly one extra DM per concurrent press,
    // which defeats the point of having a cap. The key advances with the counter, so the second
    // (legitimate) nudge is not blocked by the first one's claim.
    const ok = await this.trySend(
      () => this.client.sendButtonTemplate({ igsid }, campaign.copy.follow_gate ?? DEFAULT_FOLLOW_GATE, [button]),
      "follow_gate_resend",
      `follow_gate_resend:${campaign.campaign_id}:${igsid}:${reasks}`,
    );
    if (ok) {
      await updateConversation(this.db, igsid, campaign.campaign_id, {
        state: "AWAITING_FOLLOW",
        follow_retries: reasks + 1,
      });
    }
    return ok;
  }

  /** Returns true if this consumed the message's one allowed nudge. */
  private async onEmail(
    campaign: Campaign,
    evt: NormalizedMessage,
    reasks: number,
    mayNudge: boolean,
  ): Promise<boolean> {
    const email = evt.email ?? extractEmail(evt.text);
    if (!email) {
      // Not a valid email (no @ / not chip-provided) — re-ask instead of silently ignoring it,
      // so the person gets a nudge rather than the bot going quiet. Resource is never sent from here.
      if (mayNudge) return this.resendEmailAsk(campaign, evt.igsid, reasks);
      return false;
    }
    // Capturing an address is progress, not a nudge: someone with two funnels waiting on an email
    // gave one address for both, and both rewards should go out.
    await this.enterState(campaign, evt.igsid, "DELIVER", { entryEvent: "email_captured", patch: { email } });
    return false;
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
  private async resendEmailAsk(campaign: Campaign, igsid: string, reasks: number): Promise<boolean> {
    if (emailReasksExhausted(reasks)) {
      console.warn(`[chatmany] email re-ask cap reached for ${igsid} on ${campaign.campaign_id}; staying quiet.`);
      return false;
    }
    const ok = await this.trySend(
      () =>
        this.client.sendQuickReplies(
          igsid,
          campaign.copy.email_ask ?? "Tap your email or reply with it 👇",
          [{ content_type: "user_email" }],
        ),
      "email_ask_resend",
      // Same reasoning as the follow-gate re-send: claimed on the counter's current value, so
      // concurrent replies contend for one key instead of each sending their own nudge.
      `email_ask_resend:${campaign.campaign_id}:${igsid}:${reasks}`,
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
    return ok;
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

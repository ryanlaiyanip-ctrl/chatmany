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
    // Fetched up front, once per message rather than once per funnel.
    //
    // An earlier version of this used the labels gathered here to DISCARD any message whose text
    // matched one of our buttons, on the grounds that it was the echo of a press we had already
    // handled. That is superseded: a label match is now how a press is recognised when its payload
    // never arrives, so discarding it is exactly backwards — it was throwing away the second chance
    // and leaving people stuck at the gate with the reward undelivered. Entering a state is
    // idempotent, so letting the echo advance costs nothing when the payload did arrive.
    const campaigns = new Map<string, Campaign>();
    for (const convo of all) {
      const campaign = await getCampaign(this.db, convo.campaign_id);
      if (campaign) campaigns.set(convo.campaign_id, campaign);
    }

    let acted = false;
    /**
     * A press recognised by its LABEL rather than its payload names no campaign, so it may advance
     * at most one funnel. Someone with two funnels open would otherwise have a single echo of
     * "Send it to me" advance both and collect both rewards for one press.
     *
     * Scoped to label-matched presses only, deliberately. An email address is not ambiguous in this
     * way — two funnels that both asked for one were both given it by the person, and both should
     * complete — so capture is never rationed.
     */
    const untaggedPress = !evt.payload;
    let labelPressUsed = false;

    /**
     * The label fallback is only trustworthy when this person has ONE funnel open.
     *
     * Campaigns share button text — every campaign on this account says "Send it to me" — so an
     * echo names neither a campaign nor even a step. With two funnels open, the echo of the press
     * that just advanced one is indistinguishable from a fresh press on the other, and honouring it
     * hands out a reward nobody pressed for. With one funnel there is nothing to confuse it with.
     *
     * Multi-funnel people are not left worse off: their presses carry campaign-tagged payloads,
     * which are exact. The fallback exists only for the case where the payload never shows up.
     */
    const labelFallback = open.length === 1;

    for (const convo of inReplyOrder(targets)) {
      // Idempotency: only act on a message that arrived after our last transition, so re-reads of
      // the same message in the conversation history don't advance the funnel twice.
      if (evt.timestamp <= convo.updated_at) continue;

      const campaign = campaigns.get(convo.campaign_id);
      if (!campaign) continue;

      switch (convo.state as State) {
        case "AWAITING_TAP":
          if (untaggedPress && labelPressUsed) break;
          if (await this.onTap(campaign, evt, labelFallback)) {
            acted = true;
            if (untaggedPress) labelPressUsed = true;
          }
          break;
        case "AWAITING_FOLLOW":
          if (untaggedPress && labelPressUsed) break;
          if (await this.onFollow(campaign, evt, labelFallback)) {
            acted = true;
            if (untaggedPress) labelPressUsed = true;
          }
          break;
        case "AWAITING_EMAIL":
          if (await this.onEmail(campaign, evt, convo.email_retries, !acted)) acted = true;
          break;
        default:
          break; // NEW / DELIVER / DONE — nothing to do
      }
    }
  }

  /** Returns true if this message advanced the funnel. */
  private async onTap(campaign: Campaign, evt: NormalizedMessage, labelFallback: boolean): Promise<boolean> {
    const title = labelFallback ? buttonTitle(campaign.copy.opening_button, "Continue") : undefined;
    if (!confirmsTap(evt, title)) {
      // Not the press: a typed reply, a stray payload, anything else. They stay where they are and
      // we send nothing. The opening DM with its button is already in the thread; a second copy
      // would say nothing new, and deciding they "need" one means classifying signals we cannot
      // reliably classify. See the note on re-sends in transitions.ts.
      return false; // stay in AWAITING_TAP, silently
    }
    // The button_clicked event is logged inside enterState, only once the next message actually
    // sends, so a failed send leaves the tap message unconsumed (updated_at unchanged) for a
    // clean retry.
    await this.enterState(campaign, evt.igsid, afterTap(campaign), { entryEvent: "button_clicked" });
    return true;
  }


  /** Returns true if this message advanced the funnel. */
  private async onFollow(campaign: Campaign, evt: NormalizedMessage, labelFallback: boolean): Promise<boolean> {
    const title = labelFallback ? buttonTitle(campaign.copy.follow_button, DEFAULT_FOLLOW_BUTTON) : undefined;
    if (!confirmsFollow(evt, title)) {
      return false; // not the press — stay at the gate, silently
    }

    await this.enterState(campaign, evt.igsid, afterFollow(campaign), {
      entryEvent: "follow_confirmed",
      patch: { followed: 1 },
    });
    return true;
  }


  /** Returns true if this message advanced the funnel or spent the one allowed email re-ask. */
  private async onEmail(
    campaign: Campaign,
    evt: NormalizedMessage,
    reasks: number,
    mayAct: boolean,
  ): Promise<boolean> {
    const email = evt.email ?? extractEmail(evt.text);
    if (!email) {
      // Not a valid email (no @ / not chip-provided) — re-ask instead of silently ignoring it, so
      // the person gets a nudge rather than the bot going quiet. Resource is never sent from here.
      //
      // Gated on mayReplyTo like the other two states, which this step was missing: a button
      // payload landing here — a stale button of ours, or another app's event entirely — is not
      // somebody failing to give an address, and used to draw an email re-ask off the back of it.
      // Only a reply, and only when this message has not already acted somewhere.
      //
      // Deliberately NOT gated on there being text. A photo, sticker or voice note arrives with no
      // `text` field at all and is still a person replying, so refusing to answer those would go
      // quiet on someone genuinely engaging.
      //
      // That is also why read receipts must be stopped at the TRANSPORT and not here: normalized,
      // a receipt and a voice note are the same event — no text, no payload — and only the webhook
      // payload still knows which is which (a receipt carries no `message` at all). See the filter
      // in routes/webhook.ts; getting it wrong there meant this step answered somebody OPENING the
      // thread with another "your email?", once per receipt.
      if (mayAct && !evt.payload) return this.resendEmailAsk(campaign, evt.igsid, reasks);
      return false;
    }
    // Capturing an address is progress, not a nudge: someone with two funnels waiting on an email
    // gave one address for both, and both rewards should go out.
    await this.enterState(campaign, evt.igsid, "DELIVER", { entryEvent: "email_captured", patch: { email } });
    return true;
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

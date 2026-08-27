// Pure state-transition logic (Section 6 state machine). No I/O — the orchestrator (engine.ts)
// applies these decisions against the DB and the send queue.
//
//   NEW ─opening private reply─▶ AWAITING_TAP
//   AWAITING_TAP ─opening postback─▶ ( check_follow ? AWAITING_FOLLOW : ask_email ? AWAITING_EMAIL : DELIVER )
//   AWAITING_FOLLOW ─gate postback─▶ ( ask_email ? AWAITING_EMAIL : DELIVER )
//   AWAITING_EMAIL ─email─▶ DELIVER
//   DELIVER ─▶ DONE
//
// The two postback transitions require OUR payload. A typed reply is not a press: it gets a capped
// re-send of the button it ignored, and the funnel stays where it is.

import type { Campaign, State } from "../types";

/** After a tap in AWAITING_TAP, where do we go next given the campaign toggles? */
export function afterTap(campaign: Campaign): State {
  if (campaign.check_follow) return "AWAITING_FOLLOW";
  if (campaign.ask_email) return "AWAITING_EMAIL";
  return "DELIVER";
}

/**
 * How many times we will re-ask for an email before going quiet.
 *
 * The ask is sent once on entering AWAITING_EMAIL; this bounds the follow-ups after that, so the
 * worst case is three DMs about email rather than one per reply forever. Reaching the cap does not
 * close the conversation — a real address arriving later is still captured and still delivers.
 */
const MAX_EMAIL_REASKS = 2;

export function emailReasksExhausted(retries: number): boolean {
  return retries >= MAX_EMAIL_REASKS;
}

/**
 * The opening DM and the follow gate are each sent EXACTLY ONCE per person, ever. There is no
 * re-send of either, at any cap.
 *
 * Both are button templates: once sent they stay in the transcript permanently, so a second copy
 * carries no information the first does not. Every attempt to be helpful by re-sending them ended
 * up producing duplicates instead, because deciding "this person is stuck and needs a reminder"
 * means classifying every inbound signal correctly, and the signals are not all classifiable — read
 * receipts, reactions, re-deliveries and label echoes all arrive looking like a reply. Not sending
 * removes the need to classify at all, which is why it is a guarantee rather than another cap.
 *
 * The email ask is different and still re-asks (see MAX_EMAIL_REASKS): it goes out as quick-reply
 * chips, and Instagram destroys those the moment the person types or leaves the thread, so there
 * genuinely may be nothing left on screen for them to act on.
 */

/** After a confirmed follow, where next? */
export function afterFollow(campaign: Campaign): State {
  if (campaign.ask_email) return "AWAITING_EMAIL";
  return "DELIVER";
}

/** Postback payloads carried by our own buttons. Webhook mode delivers these verbatim; polling
 *  mode never surfaces them, which is why the predicates below also accept plain messages. */
export const OPENING_PAYLOAD = "OPENING_TAP";
export const FOLLOW_PAYLOAD = "FOLLOW_CONFIRM";

/**
 * Tag a button payload with the campaign that sent it, as `KIND:campaign_id`.
 *
 * Without this every campaign's opening button carried the identical payload "OPENING_TAP", so a
 * tap proved only that *a* button was pressed — never which one. Someone who commented on two
 * different posts had two funnels open, and one tap completed both, delivering both rewards for a
 * single interaction. The payload is invisible to the person and never stored; it just rides along
 * in the message and comes back on the press.
 */
export function taggedPayload(kind: string, campaignId: string): string {
  const tagged = `${kind}:${campaignId}`;
  if (tagged.length <= MAX_PAYLOAD_LENGTH) return tagged;
  // Nothing caps campaign_id's length, and Instagram rejects an over-long payload outright — which
  // would fail the whole send and retry it on every poll forever, so the person never gets their
  // DM at all. Degrading to an untagged payload is strictly better: the press still arrives, and
  // the legacy fallback below advances every open funnel, exactly as it did before tagging existed.
  console.warn(
    `[chatmany] campaign_id is too long to tag a button payload (${tagged.length} > ${MAX_PAYLOAD_LENGTH} chars); ` +
      `sending an untagged payload, so a press will advance every open funnel for this person.`,
  );
  return kind;
}

/** Instagram's limit on a postback payload. Over this, the send is rejected outright. */
const MAX_PAYLOAD_LENGTH = 1000;

/**
 * Split a payload into its kind and the campaign that sent it.
 *
 * `campaignId` is null for an untagged payload — a button sent before tagging existed and still
 * sitting in someone's inbox. Those must keep working, so callers fall back to the old
 * advance-everything behavior rather than ignoring the press. Splitting on the FIRST colon only
 * keeps campaign ids containing colons intact.
 */
export function parsePayload(payload: string | undefined): { kind: string | null; campaignId: string | null } {
  if (!payload) return { kind: null, campaignId: null };
  const i = payload.indexOf(":");
  if (i === -1) return { kind: payload, campaignId: null };
  return { kind: payload.slice(0, i), campaignId: payload.slice(i + 1) || null };
}

/**
 * Does this inbound message confirm the follow gate?
 *
 * The gate is sent as a postback button — the same mechanism as the opening DM — rather than a
 * quick-reply chip. Chips disappear: Instagram drops them as soon as the person types anything,
 * leaves the thread, or comes back later, which stranded people in AWAITING_FOLLOW with nothing
 * left to tap and no way to reach the reward. A button template stays in the transcript.
 *
 * A press must therefore be proven by OUR payload. This used to fall back to "any message
 * confirms" when no payload was present, which was written for polling mode (which never surfaces
 * one) — but with a webhook callback registered, a real press ALWAYS carries its payload and a
 * typed message never does. So the fallback stopped distinguishing the two and simply confirmed
 * the follow for anyone who typed anything at the gate, which is precisely what it exists to
 * prevent. Absence of a payload is now treated as what it actually is: not a press.
 */
export function confirmsFollow(evt: { text?: string; payload?: string }, buttonTitle?: string): boolean {
  if (parsePayload(evt.payload).kind === FOLLOW_PAYLOAD) return true;
  return matchesLabel(evt.text, buttonTitle);
}

/**
 * Does this inbound message confirm the opening tap?
 *
 * Same rule, same reasoning as confirmsFollow. AWAITING_TAP previously advanced on ANY inbound
 * message, so somebody who ignored the button and typed "hey" was pushed through the funnel and
 * counted as a click. The postback payload is the only thing that actually distinguishes a press
 * from a reply, so it is now required.
 */
export function confirmsTap(evt: { text?: string; payload?: string }, buttonTitle?: string): boolean {
  if (parsePayload(evt.payload).kind === OPENING_PAYLOAD) return true;
  return matchesLabel(evt.text, buttonTitle);
}

/**
 * Does this message's text match one of our button labels?
 *
 * Pressing a button also posts its label into the thread as a message from that person — the
 * bubble reading "Send it to me" that they never typed. That echo is a SECOND chance to recognise
 * a press, and it matters: somebody whose postback never arrived (or arrived and was discarded as
 * stale) was left stuck at the gate forever with their reward undelivered. Honouring the label
 * makes that a dead end no longer.
 *
 * Compared loosely on purpose. The stored label and the echoed one are not reliably byte-identical
 * — emoji come back with a presentation selector attached, whitespace gets normalised, casing can
 * differ — and a near-miss here does not degrade gracefully, it strands somebody.
 *
 * Advancing on this is safe because entering a state is idempotent: the postback and its echo both
 * resolve to the same transition, and the send claims mean the reward goes out once regardless.
 */
export function matchesLabel(text: string | undefined, title: string | undefined): boolean {
  if (!text || !title) return false;
  return normalizeLabel(text) === normalizeLabel(title);
}

function normalizeLabel(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[\uFE0E\uFE0F]/g, "") // emoji presentation selectors
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Is this message something we may answer with a re-send?
 *
 * ONLY a typed reply — a message carrying no payload at all. A nudge exists for one situation:
 * somebody talked to us instead of pressing the button, and would otherwise get silence. Any
 * payload means a button was pressed, and a press is never that situation.
 *
 * This deliberately reverses an earlier decision to answer a re-press of the OPENING button at the
 * follow gate by re-sending the gate. The reasoning then was that a press met with silence feels
 * broken. Real threads showed the cost: presses arrive more than once — people double-tap, Meta
 * re-delivers, and the poller re-reads underneath the webhook — so honouring a press we had already
 * honoured put a second identical card in the thread. Silence on a duplicate press is strictly
 * better than a duplicate DM, and costs nothing: the button we would have re-sent is already the
 * most recent thing in the conversation.
 *
 * Someone else's button payload is ignored for the separate and stronger reason that it is not our
 * event at all.
 */
export function mayReplyTo(evt: { payload?: string }): boolean {
  return parsePayload(evt.payload).kind === null;
}


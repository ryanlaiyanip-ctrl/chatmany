// Pure state-transition logic (Section 6 state machine). No I/O — the orchestrator (engine.ts)
// applies these decisions against the DB and the send queue.
//
//   NEW ─opening private reply─▶ AWAITING_TAP
//   AWAITING_TAP ─tap─▶ ( check_follow ? AWAITING_FOLLOW : ask_email ? AWAITING_EMAIL : DELIVER )
//   AWAITING_FOLLOW ─button tap / any reply─▶ ( ask_email ? AWAITING_EMAIL : DELIVER )
//   AWAITING_EMAIL ─email─▶ DELIVER
//   DELIVER ─▶ DONE

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
 * How many times we will re-send the follow gate to someone who presses the WRONG button.
 *
 * The opening button is a button template, so it stays in the transcript forever: scrolling up and
 * pressing it again while sitting at the follow gate is easy, and it used to do nothing at all —
 * they pressed a real button of ours and got silence, with no way to tell they'd pressed the wrong
 * one. Re-sending the gate puts the right button back at the bottom of the thread.
 *
 * Capped for the same reason the email re-ask is: an uncapped DM-per-press loop is the pattern
 * platform spam detection watches for. Reaching the cap only stops the re-sends — the gate itself
 * is still in the transcript, and any typed reply still advances them.
 *
 * This reuses the `follow_retries` column, which already exists in migration 0001 on every
 * deployed database and has had nothing writing to it since verify_follow_count was removed. No
 * new migration is needed.
 */
const MAX_FOLLOW_GATE_REASKS = 2;

export function followGateReasksExhausted(retries: number): boolean {
  return retries >= MAX_FOLLOW_GATE_REASKS;
}

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
 * The cost is that a postback posts no visible user text, so the old rule — match the reply
 * against the button title — can never fire in polling mode, which doesn't see the payload
 * either. So any inbound message confirms, exactly as AWAITING_TAP already does for the opening
 * button. That is weaker than it sounds: the gate is self-attestation regardless (the API cannot
 * verify that a specific person followed), and the title-match rule silently ignored every reply
 * that wasn't the chip text verbatim — a typo or an emoji-less "i followed" left them stuck.
 *
 * When a payload IS present (webhook mode) it must be ours: that distinguishes a real gate tap
 * from some other button, so those events don't cross-advance.
 */
export function confirmsFollow(evt: { text?: string; payload?: string }): boolean {
  const { kind } = parsePayload(evt.payload);
  if (kind) return kind === FOLLOW_PAYLOAD;
  return true;
}


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

/** After a confirmed follow, where next? */
export function afterFollow(campaign: Campaign): State {
  if (campaign.ask_email) return "AWAITING_EMAIL";
  return "DELIVER";
}

/** Postback payloads carried by our own buttons. Webhook mode delivers these verbatim; polling
 *  mode never surfaces them, which is why the predicate below also accepts plain messages. */
export const OPENING_PAYLOAD = "OPENING_TAP";
export const FOLLOW_PAYLOAD = "FOLLOW_CONFIRM";

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
  if (evt.payload) return evt.payload === FOLLOW_PAYLOAD;
  return true;
}


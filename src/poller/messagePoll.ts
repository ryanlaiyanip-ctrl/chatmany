// Message poll (Section 5A). Reads recent conversations and feeds inbound messages (taps,
// email replies) to the engine. This is how quick-reply taps / typed replies are received
// without webhooks. Idempotency is enforced in the engine via each conversation's updated_at,
// so re-reading the same message history is safe.
//
// Three properties matter here, all learned from a production stall (2026-08-09) in which one
// undeliverable recipient froze the poller for 15 hours:
//
//   1. One bad message must never abort the tick. handleMessage -> enterState -> SendQueue
//      throws on any non-rate-limit send error, so an unguarded loop lets a single poisoned
//      conversation kill every subsequent one, forever.
//   2. The cursor must advance even when something goes wrong. It used to be written on the
//      last line, so any throw skipped it — and a frozen cursor widens the next tick's window,
//      which is what escalated a single bad send into "Exceeded CPU Limit" on most ticks.
//   3. Work per tick must be bounded no matter how stale the cursor is, so a bad stretch can
//      never compound into an unrecoverable one.

import { kvGet, kvSet, now } from "../db";
import type { Runtime } from "../runtime";
import { toUnixSeconds } from "../runtime";
import type { NormalizedMessage } from "../types";

const CURSOR_KEY = "last_msg_poll_ts";
const ERROR_KEY = "last_msg_poll_error";
const OVERLAP_SECONDS = 120; // small look-back so nothing is missed between ticks

/**
 * Hard ceiling on the look-back window. A short API outage should still be caught up on, but a
 * long one must not hand the next tick hours of history to re-process. Without this bound the
 * poller can enter a spiral it never exits: stale cursor -> more work -> killed -> staler cursor.
 */
const MAX_LOOKBACK_SECONDS = 900; // 15 minutes

/** Ceiling on messages handed to the engine per tick, so CPU per invocation stays predictable. */
const MAX_MESSAGES_PER_TICK = 60;

export async function pollMessages(rt: Runtime, db: D1Database): Promise<void> {
  const cursorRaw = await kvGet(db, CURSOR_KEY);
  const cursor = cursorRaw ? Number(cursorRaw) : 0;
  const t = now();
  // Bounded look-back: honor the cursor, but never reach further back than MAX_LOOKBACK_SECONDS.
  const floor = cursor > 0 ? Math.max(cursor - OVERLAP_SECONDS, t - MAX_LOOKBACK_SECONDS) : 0;

  let conversations;
  try {
    conversations = await rt.client.getConversations();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[chatmany] getConversations failed: ${msg}`);
    await recordPollError(db, `getConversations: ${msg}`);
    // Deliberately leave the cursor alone: a transient read failure should be caught up on next
    // tick. MAX_LOOKBACK_SECONDS is what keeps that catch-up bounded if the outage is long.
    return;
  }

  let maxTs = cursor;
  let handled = 0;
  let failed = 0;
  let lastError = "";

  try {
    outer: for (const convo of conversations) {
      for (const m of convo.messages?.data ?? []) {
        const fromId = m.from?.id;
        if (!fromId || fromId === rt.igUserId) continue; // skip our own outbound messages
        const ts = toUnixSeconds(m.created_time);
        if (ts < floor) continue;
        if (handled >= MAX_MESSAGES_PER_TICK) break outer;
        if (ts > maxTs) maxTs = ts;
        handled++;

        const evt: NormalizedMessage = {
          kind: "message",
          igsid: fromId,
          text: m.message,
          timestamp: ts,
          // Polling does not expose the hidden quick-reply payload; the engine resolves taps by
          // matching text to the expected button title for the conversation's state.
        };

        try {
          await rt.engine.handleMessage(evt);
        } catch (e) {
          // Isolate the blast radius to this one person. The engine only commits state after a
          // successful send, so this conversation is left untouched and retried on a later tick,
          // while everyone else in this batch still gets processed.
          failed++;
          lastError = e instanceof Error ? e.message : String(e);
          console.warn(`[chatmany] handleMessage failed for ${fromId}: ${lastError}`);
        }
      }
    }
  } finally {
    // Always advance, even if something unexpected escaped above. A cursor that stops moving is
    // what turns one bad tick into a permanent outage.
    await kvSet(db, CURSOR_KEY, String(Math.max(maxTs, t - OVERLAP_SECONDS)));
  }

  if (failed > 0) {
    await recordPollError(db, `${failed}/${handled} message(s) failed; last: ${lastError}`);
  } else {
    await clearPollError(db);
  }
}

/** Record why the last poll was unhealthy, so /auth/status can surface it instead of failing mute. */
async function recordPollError(db: D1Database, message: string): Promise<void> {
  await kvSet(db, ERROR_KEY, JSON.stringify({ at: now(), message: message.slice(0, 300) }));
}

async function clearPollError(db: D1Database): Promise<void> {
  const existing = await kvGet(db, ERROR_KEY);
  if (existing) await kvSet(db, ERROR_KEY, "");
}

/** The last poll error, for the status endpoint. Null when the last poll was clean. */
export async function getPollError(db: D1Database): Promise<{ at: number; message: string } | null> {
  const raw = await kvGet(db, ERROR_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { at: number; message: string };
  } catch {
    return null;
  }
}

/** Seconds since the message poll last completed — the health signal that caught the 2026-08-09 stall. */
export async function getPollAgeSeconds(db: D1Database): Promise<number | null> {
  const raw = await kvGet(db, CURSOR_KEY);
  if (!raw) return null;
  return now() - Number(raw);
}

// Regression tests for the message-poll cursor. These reproduce the production stall observed on
// 2026-08-09: `last_msg_poll_ts` frozen 3.5h in the past while `last_poll_ts` stayed current, with
// ~60% of cron ticks dying on "Exceeded CPU Limit".
//
// The failure is self-reinforcing:
//   1. a tick is killed (or getConversations throws) before the cursor write on the last line
//   2. the cursor stays frozen, so the next tick's look-back window is that much wider
//   3. a wider window means more messages handed to the engine -> more CPU -> killed again
//
// These tests pin down steps 1 and 2 — the parts that live in our code.

import { describe, expect, it } from "vitest";
import { pollMessages } from "../src/poller/messagePoll";
import { kvGet, kvSet, now } from "../src/db";
import type { Runtime } from "../src/runtime";
import { makeTestDb } from "./helpers/fakeD1";
import type { IgConversation } from "../src/api/client";

const CURSOR_KEY = "last_msg_poll_ts";
const IG_USER_ID = "me";
const MAX_MESSAGES_PER_TICK = 60; // mirrors the cap in messagePoll.ts

/**
 * 200 inbound messages (20 conversations x 10) spread evenly over the last 4 hours — the shape
 * `getConversations` returns at its default limits. Message i is 72s older than message i-1.
 */
function conversationHistory(t: number): IgConversation[] {
  const convos: IgConversation[] = [];
  for (let c = 0; c < 20; c++) {
    const messages = [];
    for (let m = 0; m < 10; m++) {
      const i = c * 10 + m;
      messages.push({
        id: `msg${i}`,
        from: { id: `user${i}` }, // never IG_USER_ID, so nothing is skipped as our own outbound
        message: "hi",
        created_time: new Date((t - i * 72) * 1000).toISOString(),
      });
    }
    convos.push({ id: `convo${c}`, messages: { data: messages } });
  }
  return convos;
}

interface Harness {
  rt: Runtime;
  handled: string[];
}

function harness(opts: { convos?: IgConversation[]; throws?: boolean }): Harness {
  const handled: string[] = [];
  const rt = {
    igUserId: IG_USER_ID,
    client: {
      getConversations: async () => {
        if (opts.throws) throw new Error("(#10) Application does not have permission for this action");
        return opts.convos ?? [];
      },
    },
    engine: {
      handleMessage: async (evt: { igsid: string }) => {
        handled.push(evt.igsid);
      },
    },
  } as unknown as Runtime;
  return { rt, handled };
}

describe("message poll cursor", () => {
  it("advances the cursor to ~now on a healthy run", async () => {
    const db = makeTestDb();
    const t = now();
    await kvSet(db, CURSOR_KEY, String(t - 3600));

    const { rt } = harness({ convos: conversationHistory(t) });
    await pollMessages(rt, db);

    const cursor = Number(await kvGet(db, CURSOR_KEY));
    expect(cursor).toBeGreaterThanOrEqual(t - 121);
  });

  it("leaves the cursor frozen when getConversations throws", async () => {
    const db = makeTestDb();
    const t = now();
    const stale = t - 12917; // the exact 3h35m staleness seen in production
    await kvSet(db, CURSOR_KEY, String(stale));

    const { rt, handled } = harness({ throws: true });
    await pollMessages(rt, db); // swallowed: logs a warning and returns

    expect(handled).toHaveLength(0);
    // The cursor write is the last line of pollMessages, so the early return skips it entirely.
    expect(Number(await kvGet(db, CURSOR_KEY))).toBe(stale);
  });

  it("keeps work bounded no matter how stale the cursor is", async () => {
    // Before MAX_LOOKBACK_SECONDS existed, work scaled with staleness: 4 messages per tick when
    // healthy, 52 after an hour frozen, 182 at the 3h35m seen in production — which is what
    // pushed ticks over the CPU limit and stopped the cursor advancing, deepening the freeze.
    // The bounded window makes that spiral impossible: staleness no longer buys extra work.
    const t = now();
    const counts: number[] = [];

    for (const staleness of [120, 3600, 12917, 30 * 86400]) {
      const db = makeTestDb();
      await kvSet(db, CURSOR_KEY, String(t - staleness));
      const h = harness({ convos: conversationHistory(t) });
      await pollMessages(h.rt, db);
      counts.push(h.handled.length);
    }

    // A month-old cursor must cost no more than a 15-minute-old one.
    for (const n of counts) expect(n).toBeLessThanOrEqual(MAX_MESSAGES_PER_TICK);
    expect(Math.max(...counts)).toBeLessThan(20);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThan(15);
  });

  it("keeps polling everyone else when one recipient's send fails", async () => {
    // The production wedge: handleMessage -> enterState -> SendQueue throws on a permanently
    // undeliverable recipient. Unguarded, that one throw aborted the whole tick before the
    // cursor write, so the poller re-ran the same prefix and died on the same message forever.
    const db = makeTestDb();
    const t = now();
    await kvSet(db, CURSOR_KEY, String(t - 300));

    const handled: string[] = [];
    const rt = {
      igUserId: IG_USER_ID,
      client: { getConversations: async () => conversationHistory(t) },
      engine: {
        handleMessage: async (evt: { igsid: string }) => {
          if (evt.igsid === "user2") throw new Error("(#551) This person isn't available right now");
          handled.push(evt.igsid);
        },
      },
    } as unknown as Runtime;

    await pollMessages(rt, db);

    expect(handled).not.toContain("user2"); // the poisoned one is skipped
    expect(handled.length).toBeGreaterThan(0); // everyone else still gets processed
    expect(Number(await kvGet(db, CURSOR_KEY))).toBeGreaterThanOrEqual(t - 121); // cursor advanced
  });
});

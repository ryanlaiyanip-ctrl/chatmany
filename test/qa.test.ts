// QA sweep: button handling in every combination we can construct, and the real end-to-end
// timing a commenter experiences. Tests named DEFECT record current behavior that should change.

import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../src/engine/engine";
import { SendQueue } from "../src/queue/queue";
import { claimPollSlot, getConversation, kvSet, now, upsertCampaign } from "../src/db";
import { pollIntervalSeconds } from "../src/runtime";
import type { Campaign, Env, NormalizedComment, NormalizedMessage } from "../src/types";
import { makeTestDb } from "./helpers/fakeD1";
import { FakeClient } from "./helpers/fakeClient";

const T = Math.floor(Date.now() / 1000);
const fast = () => new SendQueue({ minIntervalMs: 0, maxRetries: 0, baseBackoffMs: 0 });

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    campaign_id: "c1", media_id: "m1", keywords: ["LINK"], exclude: [],
    reward: { type: "link", value: "https://x.com/g" },
    copy: { opening: "tap", opening_button: "Go", follow_gate: "follow", follow_button: "✅ I followed", email_ask: "email?", delivery: "here {reward}" },
    ...over,
  };
}
const comment = (o: Partial<NormalizedComment> = {}): NormalizedComment =>
  ({ kind: "comment", comment_id: "cm1", igsid: "u1", username: "u1", text: "LINK", media_id: "m1", timestamp: T, ...o });
const msg = (o: Partial<NormalizedMessage> = {}): NormalizedMessage =>
  ({ kind: "message", igsid: "u1", timestamp: T + 100, ...o });

let db: D1Database, client: FakeClient, engine: Engine;
beforeEach(() => { db = makeTestDb(); client = new FakeClient(); engine = new Engine(db, client as never, fast()); });

const openingBtn = () => (client.calls.privateReply[0] as { buttons: { title: string; payload: string }[] }).buttons[0]!;
const followBtn = () => (client.calls.button[0] as { buttons: { title: string; payload: string }[] }).buttons[0]!;

describe("buttons: identical labels on both steps", () => {
  it("same text on the opening and follow buttons still routes correctly", async () => {
    const same = "Send it to me";
    await upsertCampaign(db, campaign({ check_follow: true, copy: { ...campaign().copy, opening_button: same, follow_button: same } }), true);
    await engine.handleComment(comment());
    await engine.handleMessage(msg({ payload: openingBtn().payload, timestamp: T + 10 }));
    expect((await getConversation(db, "u1", "c1"))?.state).toBe("AWAITING_FOLLOW");

    expect(openingBtn().title).toBe(followBtn().title);      // visually identical
    expect(openingBtn().payload).not.toBe(followBtn().payload); // but distinguishable

    await engine.handleMessage(msg({ payload: followBtn().payload, timestamp: T + 20 }));
    expect((await getConversation(db, "u1", "c1"))?.state).toBe("DONE");
  });

  it("identical labels in polling mode also complete (any reply advances)", async () => {
    const same = "Tap here";
    await upsertCampaign(db, campaign({ check_follow: true, copy: { ...campaign().copy, opening_button: same, follow_button: same } }), true);
    await engine.handleComment(comment());
    await engine.handleMessage(msg({ text: same, timestamp: T + 10 }));
    await engine.handleMessage(msg({ text: same, timestamp: T + 20 }));
    expect((await getConversation(db, "u1", "c1"))?.state).toBe("DONE");
  });
});

describe("buttons: pressing the wrong one", () => {
  it("DEFECT: re-pressing the opening button at the follow gate does nothing at all", async () => {
    await upsertCampaign(db, campaign({ check_follow: true }), true);
    await engine.handleComment(comment());
    const opening = openingBtn().payload;
    await engine.handleMessage(msg({ payload: opening, timestamp: T + 10 }));
    expect((await getConversation(db, "u1", "c1"))?.state).toBe("AWAITING_FOLLOW");

    // The opening button is a button template: it stays in the transcript forever. Scrolling up
    // and pressing it again is easy, and now MORE likely than with the old vanishing chips.
    const before = client.calls.button.length + client.calls.text.length;
    await engine.handleMessage(msg({ payload: opening, timestamp: T + 20 }));
    expect((await getConversation(db, "u1", "c1"))?.state).toBe("AWAITING_FOLLOW");
    expect(client.calls.button.length + client.calls.text.length).toBe(before);
    // They pressed a real button of ours and got total silence. No nudge, no re-send.
  });

  it("pressing the follow button early (still awaiting tap) advances rather than stalling", async () => {
    await upsertCampaign(db, campaign({ check_follow: true }), true);
    await engine.handleComment(comment());
    await engine.handleMessage(msg({ payload: "FOLLOW_CONFIRM:c1", timestamp: T + 10 }));
    expect((await getConversation(db, "u1", "c1"))?.state).toBe("AWAITING_FOLLOW");
  });

  it("pressing the same button twice never double-sends", async () => {
    await upsertCampaign(db, campaign({ check_follow: true }), true);
    await engine.handleComment(comment());
    const p = openingBtn().payload;
    await engine.handleMessage(msg({ payload: p, timestamp: T + 10 }));
    await engine.handleMessage(msg({ payload: p, timestamp: T + 11 }));
    await engine.handleMessage(msg({ payload: p, timestamp: T + 12 }));
    expect(client.calls.button).toHaveLength(1);
  });
});

describe("buttons: hostile and empty labels", () => {
  it("missing labels fall back to defaults rather than sending blanks", async () => {
    await upsertCampaign(db, campaign({ check_follow: true, copy: { opening: "o", delivery: "d {reward}" } as never }), true);
    await engine.handleComment(comment());
    expect(openingBtn().title).toBe("Continue");
    await engine.handleMessage(msg({ timestamp: T + 10 }));
    expect(followBtn().title).toBe("✅ I followed");
  });

  it("DEFECT: an over-long button label is sent as-is; Instagram caps titles at 20 chars", async () => {
    const long = "Tap this button right here to get your free guide now";
    await upsertCampaign(db, campaign({ copy: { ...campaign().copy, opening_button: long } }), true);
    await engine.handleComment(comment());
    expect(openingBtn().title).toBe(long);
    expect(openingBtn().title.length).toBeGreaterThan(20);
    // Nothing validates this. Instagram rejects the send, which is a definitive 4xx, so the
    // opening is retried on every poll forever — the same permanent hot loop as the other causes.
  });

  it("emoji-only and quoted labels survive intact", async () => {
    await upsertCampaign(db, campaign({ copy: { ...campaign().copy, opening_button: '🔥"go"' } }), true);
    await engine.handleComment(comment());
    expect(openingBtn().title).toBe('🔥"go"');
  });
});

describe("timing: what a commenter actually waits", () => {
  const envOf = (o: Partial<Record<string, string>>) => o as unknown as Env;

  it("DEFECT: a 90s interval on a 60s cron actually polls every 120s", async () => {
    // The cron can only fire on the minute, and the claim needs POLL_INTERVAL_SECONDS elapsed.
    await kvSet(db, "last_poll_ts", String(now() - 60));
    expect(await claimPollSlot(db, 90)).toBe(false); // the 60s tick is refused...

    await kvSet(db, "last_poll_ts", String(now() - 120));
    expect(await claimPollSlot(db, 90)).toBe(true);  // ...so the next chance is 120s
    // Worst-case comment-to-DM is therefore ~120s, not the ~90s the README advertises.
  });

  it("a 60s interval polls on every cron tick, halving the wait", async () => {
    await kvSet(db, "last_poll_ts", String(now() - 60));
    expect(await claimPollSlot(db, 60)).toBe(true);
  });

  it("the shipped default resolves to polling at 90s", () => {
    expect(pollIntervalSeconds(envOf({ MODE: "polling", POLL_INTERVAL_SECONDS: "90" }))).toBe(90);
  });

  it("webhook mode adds no delay of its own", () => {
    // Push events go straight to the engine; the interval only governs the safety-net sweep.
    expect(pollIntervalSeconds(envOf({ MODE: "webhook", WEBHOOK_RECONCILE_SECONDS: "900" }))).toBe(900);
    expect(pollIntervalSeconds(envOf({ MODE: "webhook", WEBHOOK_RECONCILE_SECONDS: "off" }))).toBeNull();
  });

  it("send pacing adds ~1.2s per person in a burst", async () => {
    const q = new SendQueue(); // production defaults
    const started = Date.now();
    await q.run(async () => "a");
    await q.run(async () => "b");
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    // 20 comments in one poll => the last person waits ~24s longer than the first.
  });
});

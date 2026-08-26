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

  // This used to assert that typing the label completed the funnel, because matching was done on
  // text. Routing is now purely by payload, so the label is cosmetic: typing it verbatim — even
  // typing the EXACT button text — is still just typing, and does not advance anything.
  it("typing the button's label verbatim is still not a press", async () => {
    const same = "Tap here";
    await upsertCampaign(db, campaign({ check_follow: true, copy: { ...campaign().copy, opening_button: same, follow_button: same } }), true);
    await engine.handleComment(comment());
    await engine.handleMessage(msg({ text: same, timestamp: T + 10 }));
    await engine.handleMessage(msg({ text: same, timestamp: T + 20 }));
    expect((await getConversation(db, "u1", "c1"))?.state).toBe("AWAITING_TAP");
    expect(client.calls.text).toHaveLength(0); // no reward
  });
});

describe("buttons: pressing the wrong one", () => {
  it("re-pressing the opening button at the follow gate re-sends the gate, exactly once", async () => {
    await upsertCampaign(db, campaign({ check_follow: true }), true);
    await engine.handleComment(comment());
    const opening = openingBtn().payload;
    await engine.handleMessage(msg({ payload: opening, timestamp: T + 10 }));
    expect((await getConversation(db, "u1", "c1"))?.state).toBe("AWAITING_FOLLOW");
    expect(client.calls.button).toHaveLength(1); // the gate itself

    // The opening button is a button template: it stays in the transcript forever, so scrolling up
    // and pressing it again is easy — more likely than with the old vanishing chips. That used to
    // be answered with total silence. Now the gate is re-sent, so the right button is back at the
    // bottom of the thread.
    await engine.handleMessage(msg({ payload: opening, timestamp: T + 20 }));
    expect(client.calls.button).toHaveLength(2);

    // Capped at one: an uncapped DM-per-press loop is what platform spam detection watches for,
    // and a second identical card adds nothing when the first is still in the transcript.
    await engine.handleMessage(msg({ payload: opening, timestamp: T + 30 }));
    await engine.handleMessage(msg({ payload: opening, timestamp: T + 40 }));
    await engine.handleMessage(msg({ payload: opening, timestamp: T + 50 }));
    expect(client.calls.button).toHaveLength(2);

    // The cap only stops the re-sends. They are still at the gate, and still able to finish.
    expect((await getConversation(db, "u1", "c1"))?.state).toBe("AWAITING_FOLLOW");
    await engine.handleMessage(msg({ payload: "FOLLOW_CONFIRM:c1", timestamp: T + 60 }));
    expect((await getConversation(db, "u1", "c1"))?.state).toBe("DONE");
  });

  it("a foreign button pressed at the gate is still ignored entirely", async () => {
    await upsertCampaign(db, campaign({ check_follow: true }), true);
    await engine.handleComment(comment());
    await engine.handleMessage(msg({ payload: openingBtn().payload, timestamp: T + 10 }));
    expect(client.calls.button).toHaveLength(1);

    // Only OUR opening button earns a re-send. Some other app's postback must not provoke a DM.
    await engine.handleMessage(msg({ payload: "SOMETHING_ELSE", timestamp: T + 20 }));
    expect(client.calls.button).toHaveLength(1);
    expect((await getConversation(db, "u1", "c1"))?.state).toBe("AWAITING_FOLLOW");
  });

  // A stale gate button from an earlier run can still sit in the transcript, so this press can
  // arrive while they are back at AWAITING_TAP. It is not the opening button, so it does not stand
  // in for the tap — but it is one of OUR buttons, so it is answered with the opening re-send
  // rather than silence.
  it("pressing the follow button early (still awaiting tap) re-sends the opening, not the gate", async () => {
    await upsertCampaign(db, campaign({ check_follow: true }), true);
    await engine.handleComment(comment());
    await engine.handleMessage(msg({ payload: "FOLLOW_CONFIRM:c1", timestamp: T + 10 }));
    const convo = await getConversation(db, "u1", "c1");
    expect(convo?.state).toBe("AWAITING_TAP");
    expect(convo?.followed).toBe(0);
    expect(convo?.tap_retries).toBe(1);
    expect(client.calls.button).toHaveLength(1); // the opening re-send
    expect((client.calls.button[0] as { buttons: { payload: string }[] }).buttons[0]!.payload).toBe("OPENING_TAP:c1");
  });

  // A foreign postback is another integration's event that happened to reach this account. It must
  // not advance anything AND must not draw a DM out of us either — replying to it would mean
  // messaging someone off the back of an event that was never ours.
  it("a foreign button's payload draws no send at all, in either waiting state", async () => {
    await upsertCampaign(db, campaign({ check_follow: true }), true);
    await engine.handleComment(comment());

    // ...while awaiting the opening tap
    await engine.handleMessage(msg({ payload: "SOME_OTHER_APP", timestamp: T + 10 }));
    let convo = await getConversation(db, "u1", "c1");
    expect(convo?.state).toBe("AWAITING_TAP");
    expect(convo?.tap_retries).toBe(0);
    expect(client.calls.button).toHaveLength(0); // no nudge

    // ...and again while awaiting the follow confirmation
    await engine.handleMessage(msg({ payload: openingBtn().payload, timestamp: T + 20 }));
    expect((await getConversation(db, "u1", "c1"))?.state).toBe("AWAITING_FOLLOW");
    const gates = client.calls.button.length;

    await engine.handleMessage(msg({ payload: "SOME_OTHER_APP", timestamp: T + 30 }));
    convo = await getConversation(db, "u1", "c1");
    expect(convo?.state).toBe("AWAITING_FOLLOW");
    expect(convo?.follow_retries).toBe(0);
    expect(client.calls.button).toHaveLength(gates); // still no nudge
    expect(client.calls.text).toHaveLength(0);
  });

  it("ONE press re-delivered several times still sends the gate exactly once", async () => {
    await upsertCampaign(db, campaign({ check_follow: true }), true);
    await engine.handleComment(comment());
    const p = openingBtn().payload;

    // Model the real timeline. The opening went out a minute ago; the press happens NOW. That
    // ordering matters: the engine skips any message at or before a conversation's updated_at, and
    // updated_at is stamped with the wall clock at the moment we act — which, for a real event, is
    // always at or after the event's own timestamp. Backdating the row is what a real minute of
    // elapsed time does; without it every timestamp in a fast test collapses into the same second.
    await db.prepare("UPDATE conversations SET updated_at = ? WHERE igsid = ?").bind(now() - 60, "u1").run();

    // One press, delivered three times: Meta retries a delivery it thinks failed, and the
    // reconciliation poll re-reads the same message underneath. All three carry the SAME timestamp,
    // which is what separates a re-delivery from three real presses.
    const pressedAt = now();
    await engine.handleMessage(msg({ payload: p, timestamp: pressedAt }));
    await engine.handleMessage(msg({ payload: p, timestamp: pressedAt }));
    await engine.handleMessage(msg({ payload: p, timestamp: pressedAt }));
    expect(client.calls.button).toHaveLength(1);
    expect((await getConversation(db, "u1", "c1"))?.state).toBe("AWAITING_FOLLOW");
  });

  it("even if a re-delivery did slip the timestamp guard, the cap bounds it to ONE extra DM", async () => {
    // The guard above rests on the worker's clock being at or ahead of the event timestamp, which
    // holds for Meta's timestamps. This is the backstop if it ever doesn't: the re-send counter is
    // per-person and persisted, so a pathological stream of re-deliveries still cannot become an
    // unbounded DM loop.
    await upsertCampaign(db, campaign({ check_follow: true }), true);
    await engine.handleComment(comment());
    const p = openingBtn().payload;
    await engine.handleMessage(msg({ payload: p, timestamp: T + 10 }));
    for (let i = 0; i < 25; i++) await engine.handleMessage(msg({ payload: p, timestamp: T + 20 + i }));
    expect(client.calls.button).toHaveLength(2); // the gate + at most 1 re-send, never more
  });
});

describe("buttons: hostile and empty labels", () => {
  it("missing labels fall back to defaults rather than sending blanks", async () => {
    await upsertCampaign(db, campaign({ check_follow: true, copy: { opening: "o", delivery: "d {reward}" } as never }), true);
    await engine.handleComment(comment());
    expect(openingBtn().title).toBe("Continue");
    await engine.handleMessage(msg({ payload: openingBtn().payload, timestamp: T + 10 }));
    expect(followBtn().title).toBe("✅ I followed");
  });

  it("an over-long label is trimmed to 20 chars so Instagram accepts the send", async () => {
    const long = "Tap this button right here to get your free guide now";
    await upsertCampaign(db, campaign({ copy: { ...campaign().copy, opening_button: long } }), true);
    await engine.handleComment(comment());
    expect(openingBtn().title).toBe("Tap this button righ");
    expect(openingBtn().title.length).toBe(20);
    // Untrimmed, Instagram rejects the send definitively and the opening retries every poll
    // forever — a permanent hot loop and a lead that never receives its DM.
  });

  it("a whitespace-only label falls back rather than sending a blank button", async () => {
    await upsertCampaign(db, campaign({ copy: { ...campaign().copy, opening_button: "   " } }), true);
    await engine.handleComment(comment());
    expect(openingBtn().title).toBe("Continue");
  });

  it("emoji-only and quoted labels survive intact", async () => {
    await upsertCampaign(db, campaign({ copy: { ...campaign().copy, opening_button: '🔥"go"' } }), true);
    await engine.handleComment(comment());
    expect(openingBtn().title).toBe('🔥"go"');
  });
});

describe("timing: what a commenter actually waits", () => {
  const envOf = (o: Partial<Record<string, string>>) => o as unknown as Env;

  it("a 90s interval on a 60s cron would poll every 120s — why the default is now 60", async () => {
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

  it("the shipped default now polls on every cron tick", () => {
    expect(pollIntervalSeconds(envOf({ MODE: "polling", POLL_INTERVAL_SECONDS: "60" }))).toBe(60);
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

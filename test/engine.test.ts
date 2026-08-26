import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../src/engine/engine";
import { SendQueue } from "../src/queue/queue";
import {
  deleteCampaign,
  eventCountsByType,
  getActiveCampaigns,
  getAllCampaigns,
  getConversation,
  setCampaignArchived,
  upsertCampaign,
} from "../src/db";
import type { Campaign, NormalizedComment, NormalizedMessage } from "../src/types";
import { makeTestDb } from "./helpers/fakeD1";
import { FakeClient } from "./helpers/fakeClient";

// Send queue with no pacing/backoff so tests are fast and a failed send fails immediately.
const fastQueue = () => new SendQueue({ minIntervalMs: 0, maxRetries: 0, baseBackoffMs: 0 });

const T = Math.floor(Date.now() / 1000); // messages use T + offset so they're newer than updated_at

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    campaign_id: "c1",
    name: "Test",
    media_id: "media1",
    keywords: ["Link"],
    exclude: [],
    reward: { type: "link", value: "https://x.com/g" },
    copy: {
      opening: "tap 👇",
      opening_button: "Send it",
      follow_gate: "follow first",
      follow_button: "✅ I followed",
      email_ask: "your email?",
      delivery: "here you go {reward}",
    },
    ...over,
  };
}

function comment(over: Partial<NormalizedComment> = {}): NormalizedComment {
  return {
    kind: "comment",
    comment_id: "cm1",
    igsid: "user1",
    username: "user1",
    text: "Link please",
    media_id: "media1",
    timestamp: T,
    ...over,
  };
}

function message(over: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return { kind: "message", igsid: "user1", timestamp: T + 100, ...over };
}

// A button PRESS, shaped the way a webhook delivers one: our postback payload and no visible text.
// The payload is the only thing that distinguishes a press from a typed reply, so a test that means
// "they tapped" has to say so with one of these — passing a bare message() means "they typed".
function tap(over: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return message({ payload: "OPENING_TAP:c1", ...over });
}
function gateTap(over: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return message({ payload: "FOLLOW_CONFIRM:c1", ...over });
}

let db: D1Database;
let client: FakeClient;
let engine: Engine;

beforeEach(async () => {
  db = makeTestDb();
  client = new FakeClient();
  engine = new Engine(db, client.asClient(), fastQueue());
});

async function counts(campaignId = "c1") {
  return eventCountsByType(db, campaignId, 0);
}

describe("comment handling: trigger, dedup, idempotency", () => {
  it("sends exactly one opening DM and enters AWAITING_TAP", async () => {
    await upsertCampaign(db, campaign(), true);
    await engine.handleComment(comment());

    expect(client.calls.privateReply).toHaveLength(1);
    const convo = await getConversation(db, "user1", "c1");
    expect(convo?.state).toBe("AWAITING_TAP");
    const c = await counts();
    expect(c.comment_matched).toBe(1);
    expect(c.opening_sent).toBe(1);
  });

  it("does not trigger when the keyword is only a substring (whole-word rule)", async () => {
    await upsertCampaign(db, campaign({ keywords: ["ai"] }), true);
    await engine.handleComment(comment({ text: "that's not fair", comment_id: "cmX" }));
    expect(client.calls.privateReply).toHaveLength(0);
    expect(await getConversation(db, "user1", "c1")).toBeNull();
  });

  it("multiple comments from one person produce exactly one DM", async () => {
    await upsertCampaign(db, campaign(), true);
    await engine.handleComment(comment({ comment_id: "a" }));
    await engine.handleComment(comment({ comment_id: "b" }));
    await engine.handleComment(comment({ comment_id: "c" }));
    expect(client.calls.privateReply).toHaveLength(1);
    expect((await counts()).comment_matched).toBe(1);
  });

  it("re-processing the same comment never re-sends (idempotent)", async () => {
    await upsertCampaign(db, campaign(), true);
    await engine.handleComment(comment());
    await engine.handleComment(comment()); // same comment_id, e.g. a re-poll
    expect(client.calls.privateReply).toHaveLength(1);
  });

  it("a failed opening send is retried and never double-counts comment_matched", async () => {
    await upsertCampaign(db, campaign(), true);
    client.failNext.privateReply = 1; // first opening attempt fails
    await engine.handleComment(comment());
    // Nothing recorded yet; comment left unprocessed for retry.
    expect(await getConversation(db, "user1", "c1")).toBeNull();
    let c = await counts();
    expect(c.comment_matched).toBe(0);
    expect(c.opening_sent).toBe(0);

    await engine.handleComment(comment()); // retry — succeeds
    expect(client.calls.privateReply).toHaveLength(1); // only the successful send is recorded
    expect((await getConversation(db, "user1", "c1"))?.state).toBe("AWAITING_TAP");
    c = await counts();
    expect(c.comment_matched).toBe(1); // exactly once
    expect(c.opening_sent).toBe(1);
  });

  it("runs public actions once each, guarded against re-polls", async () => {
    await upsertCampaign(db, campaign({ public_reply: { enabled: true, texts: ["hi"] } }), true);
    await engine.handleComment(comment());
    await engine.handleComment(comment()); // re-poll
    expect(client.calls.reply).toHaveLength(1);
  });

  // Instagram's API cannot like a comment — there is no /likes edge on a comment. An earlier
  // version posted to /{comment-id}/likes, which errored on every triggering comment. This test
  // previously passed only because the fake client happily accepted a call the real API rejects.
  it("never attempts to like a comment, even when an old campaign has like_comment set", async () => {
    await upsertCampaign(db, campaign({ like_comment: true, public_reply: { enabled: true, texts: ["hi"] } }), true);
    await engine.handleComment(comment());
    expect(client.calls.like).toHaveLength(0);
    expect(client.calls.reply).toHaveLength(1); // the reply still works
  });
});

describe("message handling: full funnel", () => {
  it("advances tap → follow → email → deliver with correct events and state", async () => {
    await upsertCampaign(db, campaign({ check_follow: true, ask_email: true }), true);
    await engine.handleComment(comment());

    // tap
    await engine.handleMessage(tap({ timestamp: T + 10 }));
    expect((await getConversation(db, "user1", "c1"))?.state).toBe("AWAITING_FOLLOW");
    expect(client.calls.button).toHaveLength(1); // follow gate sent as a button template, not a chip

    // follow confirm — the gate's own postback payload, the only thing that counts as a press
    await engine.handleMessage(gateTap({ timestamp: T + 20 }));
    const afterFollow = await getConversation(db, "user1", "c1");
    expect(afterFollow?.state).toBe("AWAITING_EMAIL");
    expect(afterFollow?.followed).toBe(1);
    expect(client.calls.quick).toHaveLength(1); // email ask (still a chip — the email chip is native)

    // email
    await engine.handleMessage(message({ text: "me@example.com", timestamp: T + 30 }));
    const done = await getConversation(db, "user1", "c1");
    expect(done?.state).toBe("DONE");
    expect(done?.email).toBe("me@example.com");
    expect(client.calls.text).toHaveLength(1);
    expect((client.calls.text[0] as { text: string }).text).toContain("https://x.com/g"); // {reward} filled

    const c = await counts();
    expect(c).toMatchObject({
      comment_matched: 1,
      opening_sent: 1,
      button_clicked: 1,
      follow_confirmed: 1,
      email_captured: 1,
      delivered: 1,
    });
  });

  it("sends immediately when both gates are off", async () => {
    await upsertCampaign(db, campaign(), true); // no follow, no email
    await engine.handleComment(comment());
    await engine.handleMessage(tap({ timestamp: T + 10 }));
    const convo = await getConversation(db, "user1", "c1");
    expect(convo?.state).toBe("DONE");
    expect(client.calls.text).toHaveLength(1);
  });

  it("a stale (already-consumed) message does not advance again", async () => {
    await upsertCampaign(db, campaign({ ask_email: true }), true);
    await engine.handleComment(comment());
    await engine.handleMessage(tap({ timestamp: T + 10 })); // tap → AWAITING_EMAIL
    expect((await getConversation(db, "user1", "c1"))?.state).toBe("AWAITING_EMAIL");
    // Replay an OLD message (timestamp before the last transition) — must be ignored.
    await engine.handleMessage(message({ timestamp: 1, text: "hello" }));
    expect((await getConversation(db, "user1", "c1"))?.state).toBe("AWAITING_EMAIL");
    expect((await counts()).button_clicked).toBe(1);
  });

  it("an invalid reply at the email step re-asks and never delivers the resource", async () => {
    await upsertCampaign(db, campaign({ ask_email: true }), true);
    await engine.handleComment(comment());
    await engine.handleMessage(tap({ timestamp: T + 10 })); // tap → AWAITING_EMAIL
    expect(client.calls.quick).toHaveLength(1); // the initial email-ask

    // No "@" at all — not an email.
    await engine.handleMessage(message({ text: "hey whats up", timestamp: T + 20 }));
    const convo = await getConversation(db, "user1", "c1");
    expect(convo?.state).toBe("AWAITING_EMAIL"); // never advanced to DELIVER
    expect(convo?.email).toBeNull();
    expect(client.calls.text).toHaveLength(0); // resource never sent
    expect(client.calls.quick).toHaveLength(2); // but the ask was re-sent, not silently dropped
    expect((await counts()).email_captured).toBe(0);
    expect((await counts()).delivered).toBe(0);

    // A second invalid reply re-asks again (not just once).
    await engine.handleMessage(message({ text: "still no email here", timestamp: T + 30 }));
    expect(client.calls.quick).toHaveLength(3);
    expect((await getConversation(db, "user1", "c1"))?.state).toBe("AWAITING_EMAIL");

    // Finally a real email arrives — now it delivers.
    await engine.handleMessage(message({ text: "me@example.com", timestamp: T + 40 }));
    const done = await getConversation(db, "user1", "c1");
    expect(done?.state).toBe("DONE");
    expect(done?.email).toBe("me@example.com");
    expect(client.calls.text).toHaveLength(1);
    expect((await counts()).delivered).toBe(1);
  });

  it("a failed re-ask send leaves updated_at untouched so the same invalid reply retries cleanly", async () => {
    await upsertCampaign(db, campaign({ ask_email: true }), true);
    await engine.handleComment(comment());
    await engine.handleMessage(tap({ timestamp: T + 10 })); // tap → AWAITING_EMAIL

    client.failNext.quick = 1; // the re-ask send fails
    const bad = message({ text: "not an email", timestamp: T + 20 });
    await engine.handleMessage(bad);
    expect((await getConversation(db, "user1", "c1"))?.state).toBe("AWAITING_EMAIL");
    expect(client.calls.quick).toHaveLength(1); // only the original ask, resend failed silently-safe

    await engine.handleMessage(bad); // same message retries on next poll
    expect(client.calls.quick).toHaveLength(2); // resend succeeds this time
    expect((await getConversation(db, "user1", "c1"))?.state).toBe("AWAITING_EMAIL");
  });
});

describe("downstream send failure strands nothing and retries cleanly (regression)", () => {
  it("failed email-ask send leaves AWAITING_TAP, no button_clicked, then retries once", async () => {
    await upsertCampaign(db, campaign({ ask_email: true }), true);
    await engine.handleComment(comment());

    client.failNext.quick = 1; // the email-ask send fails on first attempt
    const press = tap({ timestamp: T + 10 });
    await engine.handleMessage(press);
    // No advance, no event, updated_at unchanged (so the same tap can retry).
    expect((await getConversation(db, "user1", "c1"))?.state).toBe("AWAITING_TAP");
    expect((await counts()).button_clicked).toBe(0);

    await engine.handleMessage(press); // retry with the same message
    expect((await getConversation(db, "user1", "c1"))?.state).toBe("AWAITING_EMAIL");
    expect((await counts()).button_clicked).toBe(1); // exactly once, not twice
  });

  it("failed delivery after email capture does not strand the contact", async () => {
    await upsertCampaign(db, campaign({ ask_email: true }), true);
    await engine.handleComment(comment());
    await engine.handleMessage(tap({ timestamp: T + 10 })); // → AWAITING_EMAIL

    client.failNext.text = 1; // delivery fails first time
    const email = message({ text: "me@example.com", timestamp: T + 20 });
    await engine.handleMessage(email);
    // Nothing committed: still awaiting email, no email stored, no events.
    const stranded = await getConversation(db, "user1", "c1");
    expect(stranded?.state).toBe("AWAITING_EMAIL");
    expect(stranded?.email).toBeNull();
    let c = await counts();
    expect(c.email_captured).toBe(0);
    expect(c.delivered).toBe(0);

    await engine.handleMessage(email); // retry — delivery succeeds
    const done = await getConversation(db, "user1", "c1");
    expect(done?.state).toBe("DONE");
    expect(done?.email).toBe("me@example.com");
    c = await counts();
    expect(c.email_captured).toBe(1);
    expect(c.delivered).toBe(1);
  });
});

describe("deleting a campaign stops it (QA: does delete actually stop an active campaign)", () => {
  it("a comment posted after deletion is no longer eligible for matching", async () => {
    await upsertCampaign(db, campaign(), true);
    expect(await getActiveCampaigns(db)).toHaveLength(1); // pre-delete: poller would scan this

    await deleteCampaign(db, "c1");
    expect(await getActiveCampaigns(db)).toHaveLength(0); // post-delete: commentPoll skips this media entirely

    // Even if a stray event slips through, the engine has nothing to match against.
    await engine.handleComment(comment());
    expect(client.calls.privateReply).toHaveLength(0);
    expect(await getConversation(db, "user1", "c1")).toBeNull();
  });

  it("someone already mid-funnel stops receiving messages, with no crash, once their campaign is deleted", async () => {
    await upsertCampaign(db, campaign({ check_follow: true }), true);
    await engine.handleComment(comment());
    await engine.handleMessage(tap({ timestamp: T + 10 })); // tap → AWAITING_FOLLOW
    expect((await getConversation(db, "user1", "c1"))?.state).toBe("AWAITING_FOLLOW");
    expect(client.calls.button).toHaveLength(1); // follow-gate already sent

    await deleteCampaign(db, "c1"); // delete mid-funnel, exactly like clicking Delete in the UI
    // Delete cascades: their conversation row for c1 is gone too, not just orphaned in place —
    // see the recreate-same-id regression test below for why that matters.
    expect(await getConversation(db, "user1", "c1")).toBeNull();

    // The next inbound message from this same person must not crash and must not send anything —
    // getCampaign(campaign_id) resolves to null for a deleted campaign, and the engine skips it.
    await engine.handleMessage(message({ text: "✅ I followed", timestamp: T + 20 }));
    expect(client.calls.button).toHaveLength(1); // no additional send
    expect(client.calls.text).toHaveLength(0); // resource never delivered
    expect(await getConversation(db, "user1", "c1")).toBeNull(); // still gone, nothing resurrected it
    const c = await counts();
    expect(c.follow_confirmed).toBe(0);
    expect(c.delivered).toBe(0);
  });

  it("regression: recreating a campaign with the same id after deletion does not inherit the old dedup history", async () => {
    await upsertCampaign(db, campaign(), true);
    await engine.handleComment(comment()); // user1 completes the opening step on c1
    expect(await getConversation(db, "user1", "c1")).not.toBeNull();
    expect(client.calls.privateReply).toHaveLength(1);

    await deleteCampaign(db, "c1"); // e.g. clicking Delete in the UI

    // The builder UI slugifies the campaign name into an id, so re-creating a campaign with the
    // same name reuses the same campaign_id. Before the cascade-delete fix, user1's old
    // conversation row for "c1" would still exist, silently blocking their opening DM here too.
    await upsertCampaign(db, campaign(), true);
    expect(await getConversation(db, "user1", "c1")).toBeNull(); // no leftover history

    await engine.handleComment(comment({ comment_id: "cm2" })); // same commenter, fresh campaign row
    expect(client.calls.privateReply).toHaveLength(2); // opening DM sent again, not skipped
    expect(await getConversation(db, "user1", "c1")).not.toBeNull();
  });
});

describe("archiving a campaign (soft-delete)", () => {
  it("stops the automation but keeps its history, unlike delete", async () => {
    await upsertCampaign(db, campaign(), true);
    await engine.handleComment(comment());
    expect(await getConversation(db, "user1", "c1")).not.toBeNull();

    await setCampaignArchived(db, "c1", true);

    // Archived campaigns are not polled, even though their `active` flag is untouched.
    expect(await getActiveCampaigns(db)).toHaveLength(0);
    // Unlike deleteCampaign, archiving does not touch conversation history.
    expect(await getConversation(db, "user1", "c1")).not.toBeNull();
    // It moves from the main list to the archived list.
    expect(await getAllCampaigns(db)).toHaveLength(0);
    expect(await getAllCampaigns(db, { archived: true })).toHaveLength(1);
  });

  it("restoring an archived campaign makes it pollable again with history intact", async () => {
    await upsertCampaign(db, campaign(), true);
    await engine.handleComment(comment());
    await setCampaignArchived(db, "c1", true);

    await setCampaignArchived(db, "c1", false);

    expect(await getActiveCampaigns(db)).toHaveLength(1);
    expect(await getAllCampaigns(db)).toHaveLength(1);
    expect(await getAllCampaigns(db, { archived: true })).toHaveLength(0);
    expect(await getConversation(db, "user1", "c1")).not.toBeNull(); // still there — never deleted
  });
});

// Regression: a send that DELIVERS but then errors (timeout, dropped connection, 5xx after
// Instagram already processed it) must not cause the same DM to be sent to the person twice.
// The engine deliberately treats a thrown send as "never happened" so real failures retry —
// but when the message actually landed, that retry is a duplicate the recipient sees.
describe("follow gate is a button, not a quick-reply chip", () => {
  it("sends the gate as a button template carrying our postback payload", async () => {
    await upsertCampaign(db, campaign({ check_follow: true }), true);
    await engine.handleComment(comment());
    await engine.handleMessage(tap({ timestamp: T + 10 }));

    expect(client.calls.quick).toHaveLength(0); // no chip — chips vanish once they type or leave
    const gate = client.calls.button[0] as { igsid: string; text: string; buttons: unknown[] };
    expect(gate.igsid).toBe("user1");
    expect(gate.text).toBe("follow first");
    // Tagged with the campaign that sent it, so a press can be attributed to one funnel.
    expect(gate.buttons).toEqual([{ type: "postback", title: "✅ I followed", payload: "FOLLOW_CONFIRM:c1" }]);
  });

  it("advances on the gate's own postback payload (webhook mode)", async () => {
    await upsertCampaign(db, campaign({ check_follow: true }), true);
    await engine.handleComment(comment());
    await engine.handleMessage(tap({ timestamp: T + 10 }));

    await engine.handleMessage(message({ payload: "FOLLOW_CONFIRM:c1", timestamp: T + 20 }));
    const convo = await getConversation(db, "user1", "c1");
    expect(convo?.state).toBe("DONE");
    expect(convo?.followed).toBe(1);
  });

  it("does not advance on a different button's payload", async () => {
    await upsertCampaign(db, campaign({ check_follow: true }), true);
    await engine.handleComment(comment());
    await engine.handleMessage(tap({ timestamp: T + 10 }));

    await engine.handleMessage(message({ payload: "SOME_OTHER_BUTTON", timestamp: T + 20 }));
    expect((await getConversation(db, "user1", "c1"))?.state).toBe("AWAITING_FOLLOW");
    expect(client.calls.text).toHaveLength(0); // reward not delivered
  });

  // This used to assert the opposite — that typing anything passed the gate — on the grounds that
  // polling never surfaces a payload. With a webhook callback registered a real press always
  // carries one, so that rule was handing the reward to people who typed "what is this?" and never
  // followed anybody. Typing now leaves them at the gate, and re-sends the button they missed.
  it("does NOT advance on a plain typed reply — a reply is not a press", async () => {
    await upsertCampaign(db, campaign({ check_follow: true }), true);
    await engine.handleComment(comment());
    await engine.handleMessage(tap({ timestamp: T + 10 }));
    const gatesAfterTap = client.calls.button.length;

    await engine.handleMessage(message({ text: "i followed", timestamp: T + 20 }));

    const convo = await getConversation(db, "user1", "c1");
    expect(convo?.state).toBe("AWAITING_FOLLOW"); // still at the gate
    expect(convo?.followed).toBe(0); // and NOT recorded as a follower
    expect(client.calls.text).toHaveLength(0); // reward not delivered
    expect((await counts()).follow_confirmed).toBe(0); // funnel not inflated
    expect(client.calls.button).toHaveLength(gatesAfterTap + 1); // gate re-sent, not silence
  });

  it("re-sends the gate at most ONCE to someone who keeps typing", async () => {
    await upsertCampaign(db, campaign({ check_follow: true }), true);
    await engine.handleComment(comment());
    await engine.handleMessage(tap({ timestamp: T + 10 }));
    const base = client.calls.button.length;

    await engine.handleMessage(message({ text: "what", timestamp: T + 20 }));
    await engine.handleMessage(message({ text: "is", timestamp: T + 30 }));
    await engine.handleMessage(message({ text: "this", timestamp: T + 40 }));
    await engine.handleMessage(message({ text: "hello?", timestamp: T + 50 }));

    expect(client.calls.button).toHaveLength(base + 1); // one nudge only, not one DM per message
    expect((await getConversation(db, "user1", "c1"))?.state).toBe("AWAITING_FOLLOW");

    // The cap only stops the nudging — a real press still works afterwards.
    await engine.handleMessage(gateTap({ timestamp: T + 60 }));
    expect((await getConversation(db, "user1", "c1"))?.state).toBe("DONE");
  });
});

describe("duplicate sends when a delivered message reports failure", () => {
  it("does not send the opening DM twice when the first send delivered but errored", async () => {
    const db = makeTestDb();
    const client = new FakeClient();
    const engine = new Engine(db, client as never, fastQueue());
    await upsertCampaign(db, campaign(), true);

    // Poll 1: Instagram delivers the opening DM, then the connection drops.
    client.deliverThenFailNext.privateReply = 1;
    await engine.handleComment(comment());
    expect(client.calls.privateReply).toHaveLength(1); // the person received it

    // Poll 2: the same comment is re-read (it was never marked processed).
    await engine.handleComment(comment());

    // The person must not receive a second opening DM.
    expect(client.calls.privateReply).toHaveLength(1);
  });

  it("does not send the ORIGINAL follow gate twice when the first send delivered but errored", async () => {
    const db = makeTestDb();
    const client = new FakeClient();
    const engine = new Engine(db, client as never, fastQueue());
    await upsertCampaign(db, campaign({ check_follow: true }), true);
    await engine.handleComment(comment());

    client.deliverThenFailNext.button = 1;
    await engine.handleMessage(tap({ timestamp: T + 10 }));
    expect(client.calls.button).toHaveLength(1); // the gate reached the person

    // The outcome was never learned, so it is treated as delivered: the funnel advances past the
    // gate and the gate's send claim stays held, which is what makes a duplicate impossible.
    const convo = await getConversation(db, "user1", "c1");
    expect(convo?.state).toBe("AWAITING_FOLLOW");
    expect(convo?.follow_retries).toBe(0);

    // Re-pressing the opening button (a button template — it sits in the transcript forever) is
    // answered by the CAPPED re-send helper, never by the original gate path. follow_retries going
    // to 1 is what proves which of the two sent it: a duplicate original would leave it at 0.
    await engine.handleMessage(tap({ timestamp: T + 11 }));
    expect(client.calls.button).toHaveLength(2);
    expect((await getConversation(db, "user1", "c1"))?.follow_retries).toBe(1);
  });
});

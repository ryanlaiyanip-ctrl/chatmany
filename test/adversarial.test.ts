// Adversarial tests: deliberately hostile input, races, and abuse of every assumption the engine
// makes. Tests named DEFECT assert the behavior as it actually is today, and are wrong-on-purpose
// records of something that should change — not endorsements of it.

import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../src/engine/engine";
import { SendQueue } from "../src/queue/queue";
import { getConversation, listConversations, upsertCampaign } from "../src/db";
import { validateCampaign } from "../src/config";
import { extractEmail, matchesKeyword } from "../src/engine/match";
import { parsePayload, taggedPayload } from "../src/engine/transitions";
import { handleApi } from "../src/routes/api";
import type { Campaign, Env, NormalizedComment, NormalizedMessage } from "../src/types";
import { makeTestDb } from "./helpers/fakeD1";
import { FakeClient } from "./helpers/fakeClient";

const fastQueue = () => new SendQueue({ minIntervalMs: 0, maxRetries: 0, baseBackoffMs: 0 });
const T = Math.floor(Date.now() / 1000);

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    campaign_id: "c1",
    media_id: "m1",
    keywords: ["LINK"],
    exclude: [],
    reward: { type: "link", value: "https://x.com/g" },
    copy: { opening: "tap", opening_button: "Go", follow_gate: "follow", follow_button: "✅ I followed", email_ask: "email?", delivery: "here {reward}" },
    ...over,
  };
}
const comment = (o: Partial<NormalizedComment> = {}): NormalizedComment =>
  ({ kind: "comment", comment_id: "cm1", igsid: "u1", username: "u1", text: "LINK", media_id: "m1", timestamp: T, ...o });
const message = (o: Partial<NormalizedMessage> = {}): NormalizedMessage =>
  ({ kind: "message", igsid: "u1", timestamp: T + 100, ...o });

// A PRESS of our opening button, as a webhook delivers it. A bare message() is a TYPED reply, and
// since the payload is the only thing separating the two, tests that mean "they tapped" must say so.
const tap = (o: Partial<NormalizedMessage> = {}): NormalizedMessage =>
  message({ payload: "OPENING_TAP:c1", ...o });

let db: D1Database;
let client: FakeClient;
let engine: Engine;
beforeEach(() => {
  db = makeTestDb();
  client = new FakeClient();
  engine = new Engine(db, client as never, fastQueue());
});

// ─────────────────────────────────────────────────────────────────────────────
describe("races: the same event delivered twice at once", () => {
  it("two concurrent deliveries of one comment send exactly one DM", async () => {
    await upsertCampaign(db, campaign(), true);
    // Meta retries webhooks; a retry can land while the first is still in flight.
    await Promise.all([engine.handleComment(comment()), engine.handleComment(comment())]);
    expect(client.calls.privateReply).toHaveLength(1);
  });

  it("five concurrent deliveries still send exactly one DM", async () => {
    await upsertCampaign(db, campaign(), true);
    await Promise.all(Array.from({ length: 5 }, () => engine.handleComment(comment())));
    expect(client.calls.privateReply).toHaveLength(1);
  });

  it("concurrent inbound messages do not double-deliver the reward", async () => {
    await upsertCampaign(db, campaign(), true);
    await engine.handleComment(comment());
    await Promise.all([
      engine.handleMessage(tap({ timestamp: T + 10 })),
      engine.handleMessage(tap({ timestamp: T + 11 })),
    ]);
    expect(client.calls.text).toHaveLength(1);
    expect((await getConversation(db, "u1", "c1"))?.state).toBe("DONE");
  });

  it("concurrent presses across two campaigns deliver one reward each, not four", async () => {
    await upsertCampaign(db, campaign({ campaign_id: "c1", media_id: "m1", keywords: ["LINK"] }), true);
    await upsertCampaign(db, campaign({ campaign_id: "c2", media_id: "m2", keywords: ["GUIDE"] }), true);
    await engine.handleComment(comment({ comment_id: "a", text: "LINK", media_id: "m1" }));
    await engine.handleComment(comment({ comment_id: "b", text: "GUIDE", media_id: "m2" }));
    await Promise.all([
      engine.handleMessage(message({ payload: "OPENING_TAP:c1", timestamp: T + 10 })),
      engine.handleMessage(message({ payload: "OPENING_TAP:c2", timestamp: T + 11 })),
    ]);
    expect(client.calls.text).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("hostile campaign ids (config import accepts any string)", () => {
  it("a campaign id containing a colon still round-trips", async () => {
    const id = "weird:id:with:colons";
    await upsertCampaign(db, campaign({ campaign_id: id }), true);
    await engine.handleComment(comment());
    const sent = client.calls.privateReply[0] as { buttons: { payload: string }[] };
    expect(parsePayload(sent.buttons[0]!.payload).campaignId).toBe(id);

    await engine.handleMessage(message({ payload: taggedPayload("OPENING_TAP", id), timestamp: T + 10 }));
    expect((await getConversation(db, "u1", id))?.state).toBe("DONE");
  });

  it("a huge campaign id falls back to an untagged payload instead of an unsendable one", async () => {
    const huge = "x".repeat(2000);
    // validateCampaign still imposes no length limit, so config import accepts this happily.
    expect(() => validateCampaign({ ...campaign({ campaign_id: huge }) })).not.toThrow();

    await upsertCampaign(db, campaign({ campaign_id: huge }), true);
    await engine.handleComment(comment());
    const sent = client.calls.privateReply[0] as { buttons: { payload: string }[] };
    const payload = sent.buttons[0]!.payload;

    // Meta caps postback payloads at ~1000 chars and rejects the whole send above it — and a
    // rejected opening is retried forever (see 4F), so the person would never get their DM at all.
    // Tagging is the part we drop: the payload degrades to the bare kind, which parsePayload
    // reports as untagged, and an untagged press advances every open funnel exactly as it did
    // before tagging existed. A slightly blunter press beats a DM that never arrives.
    expect(payload.length).toBeLessThanOrEqual(1000);
    expect(payload).toBe("OPENING_TAP");
    expect(parsePayload(payload).campaignId).toBeNull();
  });

  it("a campaign id that looks like another payload kind cannot forge a follow confirm", async () => {
    await upsertCampaign(db, campaign({ check_follow: true }), true);
    await engine.handleComment(comment());
    await engine.handleMessage(tap({ timestamp: T + 10 }));
    expect((await getConversation(db, "u1", "c1"))?.state).toBe("AWAITING_FOLLOW");

    // An opening press (wrong kind) must not satisfy the follow gate.
    await engine.handleMessage(message({ payload: "OPENING_TAP:c1", timestamp: T + 20 }));
    expect((await getConversation(db, "u1", "c1"))?.state).toBe("AWAITING_FOLLOW");
    expect(client.calls.text).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("abusive message streams", () => {
  it("someone who keeps talking is nudged twice, then left alone", async () => {
    await upsertCampaign(db, campaign({ ask_email: true }), true);
    await engine.handleComment(comment());
    await engine.handleMessage(tap({ timestamp: T + 10 })); // → AWAITING_EMAIL, 1 ask

    for (let i = 0; i < 8; i++) {
      await engine.handleMessage(message({ text: `nope ${i}`, timestamp: T + 20 + i }));
    }
    // 1 initial ask + at most 2 re-asks. Previously this was 9 DMs, one per reply, unbounded.
    expect(client.calls.quick).toHaveLength(3);
    expect((await getConversation(db, "u1", "c1"))?.state).toBe("AWAITING_EMAIL");
  });

  it("going quiet does not close the door — a later address still delivers", async () => {
    await upsertCampaign(db, campaign({ ask_email: true }), true);
    await engine.handleComment(comment());
    await engine.handleMessage(tap({ timestamp: T + 10 }));
    for (let i = 0; i < 6; i++) await engine.handleMessage(message({ text: "huh", timestamp: T + 20 + i }));
    expect(client.calls.quick).toHaveLength(3); // capped

    await engine.handleMessage(message({ text: "fine, me@example.com", timestamp: T + 90 }));
    const convo = await getConversation(db, "u1", "c1");
    expect(convo?.state).toBe("DONE");
    expect(convo?.email).toBe("me@example.com");
    expect(client.calls.text).toHaveLength(1);
  });

  it("attachment-only messages count against the cap too", async () => {
    await upsertCampaign(db, campaign({ ask_email: true }), true);
    await engine.handleComment(comment());
    await engine.handleMessage(tap({ timestamp: T + 10 }));
    // Photos, stickers and voice notes arrive with no `text` field at all.
    for (let i = 0; i < 5; i++) await engine.handleMessage(message({ timestamp: T + 20 + i }));
    expect(client.calls.quick).toHaveLength(3);
  });

  it("a failed re-ask is not counted, so the nudge is not silently spent", async () => {
    await upsertCampaign(db, campaign({ ask_email: true }), true);
    await engine.handleComment(comment());
    await engine.handleMessage(tap({ timestamp: T + 10 }));

    client.failNext.quick = 1; // Instagram rejects the first re-ask: nothing was delivered
    await engine.handleMessage(message({ text: "what", timestamp: T + 20 }));
    expect((await getConversation(db, "u1", "c1"))?.email_retries).toBe(0);

    await engine.handleMessage(message({ text: "what", timestamp: T + 30 }));
    expect((await getConversation(db, "u1", "c1"))?.email_retries).toBe(1);
  });

  it("a flood of messages after DONE sends nothing", async () => {
    await upsertCampaign(db, campaign(), true);
    await engine.handleComment(comment());
    await engine.handleMessage(tap({ timestamp: T + 10 }));
    const before = client.calls.text.length;
    for (let i = 0; i < 20; i++) await engine.handleMessage(message({ text: "hi", timestamp: T + 50 + i }));
    expect(client.calls.text).toHaveLength(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("hostile text: keywords and emails", () => {
  it("regex metacharacters in a keyword are literal, not patterns", () => {
    expect(matchesKeyword("what is 2+2", "2+2")).toBe(true);
    expect(matchesKeyword("anything at all", ".*")).toBe(false);
    expect(matchesKeyword("a.b", "a.b")).toBe(true);
    expect(matchesKeyword("axb", "a.b")).toBe(false); // '.' must not act as a wildcard
    expect(matchesKeyword("(link)", "(link)")).toBe(true);
    expect(matchesKeyword("back\\slash", "back\\slash")).toBe(true);
  });

  it("accented and space-delimited scripts bound correctly", () => {
    expect(matchesKeyword("quiero el enlace ahora", "enlace")).toBe(true);
    expect(matchesKeyword("café con leche", "café")).toBe(true);
    expect(matchesKeyword("cafés", "café")).toBe(false); // must not match inside a longer word
    expect(matchesKeyword("дайте ссылка", "ссылка")).toBe(true);
    expect(matchesKeyword("🔥 drop", "🔥")).toBe(true);
  });

  it("DEFECT: keywords never match in Chinese, Japanese, or any script without spaces", () => {
    // The whole-word rule requires a non-letter on both sides of the keyword. That is a sound
    // definition of "word" only for languages that separate words with spaces. Chinese and
    // Japanese do not, so an adjacent character is always a letter and the boundary never holds.
    expect(matchesKeyword("链接", "链接")).toBe(true); // start+end of string: the only case that works
    expect(matchesKeyword("链接 谢谢", "链接")).toBe(true); // space after
    expect(matchesKeyword("送我链接", "链接")).toBe(false); // ← natural sentence: MISSED
    expect(matchesKeyword("请发链接给我", "链接")).toBe(false); // ← MISSED
    expect(matchesKeyword("我要链接 谢谢", "链接")).toBe(false); // ← MISSED
    expect(matchesKeyword("リンクください", "リンク")).toBe(false); // ← MISSED
    expect(matchesKeyword("链接please", "链接")).toBe(false); // ← even mixed-script MISSED

    // The campaign looks correctly configured and simply never fires. There is no error, no log,
    // and the dashboard reports zero comments matched.
  });

  it("a pathological comment does not hang the matcher", () => {
    const nasty = "a".repeat(50_000) + " LINK";
    const started = Date.now();
    expect(matchesKeyword(nasty, "LINK")).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("an email carrying a spreadsheet formula is neutralized in the CSV export", async () => {
    // extractEmail's charset is [^\s@]+, which permits a leading '=' — the character Excel and
    // Sheets treat as the start of a formula. It is stored as typed; csv() defuses it on the way out.
    expect(extractEmail("=1+1@evil.com")).toBe("=1+1@evil.com");

    await upsertCampaign(db, campaign({ ask_email: true }), true);
    await engine.handleComment(comment());
    await engine.handleMessage(tap({ timestamp: T + 10 }));
    await engine.handleMessage(message({ text: "=1+1@evil.com", timestamp: T + 20 }));

    const env = { DB: db } as unknown as Env;
    const url = new URL("http://x/api/contacts/export");
    const res = await handleApi(env, new Request(url, { method: "GET" }), url);
    const csv = await res.text();
    const line = csv.split("\n").find((l) => l.includes("evil.com"))!;
    // Prefixed with an apostrophe, so Excel/Sheets/Numbers read the cell as text rather than
    // evaluating it. The apostrophe is hidden in the displayed value, so the export still reads
    // as the address the person typed.
    expect(line).toContain(",'=1+1@evil.com,");
    expect(line).not.toContain(",=1+1@evil.com,");
  });

  it("commas and quotes in stored values do not corrupt CSV columns", async () => {
    await upsertCampaign(db, campaign(), true);
    await engine.handleComment(comment({ username: 'ev,il"name' }));
    const env = { DB: db } as unknown as Env;
    const url = new URL("http://x/api/contacts/export");
    const res = await handleApi(env, new Request(url, { method: "GET" }), url);
    const csv = await res.text();
    expect(csv).toContain('"ev,il""name"'); // properly escaped
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("malformed and adversarial config", () => {
  it("rejects the obvious garbage", () => {
    expect(() => validateCampaign(null)).toThrow();
    expect(() => validateCampaign({})).toThrow();
    expect(() => validateCampaign({ campaign_id: "c", media_id: "m", keywords: [] })).toThrow();
    expect(() => validateCampaign({ campaign_id: "c", media_id: "m", keywords: [""] })).toThrow();
    expect(() => validateCampaign({ campaign_id: " ", media_id: "m", keywords: ["k"] })).toThrow();
  });

  it("a campaign row that is corrupt JSON is skipped, not fatal", async () => {
    await upsertCampaign(db, campaign(), true);
    await db.prepare("UPDATE campaigns SET config_json = '{not json' WHERE campaign_id = 'c1'").run();
    await engine.handleComment(comment()); // must not throw
    expect(client.calls.privateReply).toHaveLength(0);
  });

  it("DEFECT: a delivery message with no {reward} silently sends no link", async () => {
    await upsertCampaign(db, campaign({ copy: { ...campaign().copy, delivery: "thanks for watching!" } }), true);
    await engine.handleComment(comment());
    await engine.handleMessage(tap({ timestamp: T + 10 }));
    const sent = client.calls.text[0] as { text: string };
    expect(sent.text).toBe("thanks for watching!");
    expect(sent.text).not.toContain("x.com/g");
    // Marked delivered, funnel counted as converted, person never received the reward.
    expect((await getConversation(db, "u1", "c1"))?.state).toBe("DONE");
  });

  it("a reward value containing {reward} does not recurse", async () => {
    await upsertCampaign(db, campaign({ reward: { type: "text", value: "{reward}" } }), true);
    await engine.handleComment(comment());
    await engine.handleMessage(tap({ timestamp: T + 10 }));
    expect((client.calls.text[0] as { text: string }).text).toBe("here {reward}");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("corrupt runtime state", () => {
  it("an unrecognised state does nothing rather than throwing", async () => {
    await upsertCampaign(db, campaign(), true);
    await engine.handleComment(comment());
    await db.prepare("UPDATE conversations SET state = 'BANANA' WHERE igsid = 'u1'").run();
    await engine.handleMessage(message({ timestamp: T + 999 }));
    expect(client.calls.text).toHaveLength(0);
  });

  it("DEFECT: a conversation stuck in NEW can never move", async () => {
    await upsertCampaign(db, campaign(), true);
    await engine.handleComment(comment());
    await db.prepare("UPDATE conversations SET state = 'NEW' WHERE igsid = 'u1'").run();
    for (let i = 0; i < 5; i++) await engine.handleMessage(message({ text: "hello", timestamp: T + 500 + i }));
    expect((await getConversation(db, "u1", "c1"))?.state).toBe("NEW");
    // NEW is in the State union and is a non-terminal state, so it is returned by
    // getOpenConversations forever, but no branch handles it. Unreachable today; a trap for later.
  });

  it("a press for a campaign the person has no conversation with does nothing", async () => {
    await upsertCampaign(db, campaign(), true);
    await engine.handleComment(comment());
    await engine.handleMessage(message({ payload: "OPENING_TAP:does-not-exist", timestamp: T + 10 }));
    expect((await getConversation(db, "u1", "c1"))?.state).toBe("AWAITING_TAP");
    expect(client.calls.text).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("scale", () => {
  it("200 commenters each get exactly one opening", async () => {
    await upsertCampaign(db, campaign(), true);
    for (let i = 0; i < 200; i++) {
      await engine.handleComment(comment({ comment_id: `c${i}`, igsid: `u${i}`, username: `u${i}` }));
    }
    expect(client.calls.privateReply).toHaveLength(200);
    expect(await listConversations(db, "c1", 1000)).toHaveLength(200);
  });

  it("one person across 20 campaigns: a tagged press advances exactly one", async () => {
    for (let i = 0; i < 20; i++) {
      await upsertCampaign(db, campaign({ campaign_id: `k${i}`, media_id: `m${i}` }), true);
      await engine.handleComment(comment({ comment_id: `cm${i}`, media_id: `m${i}` }));
    }
    expect(client.calls.privateReply).toHaveLength(20);
    await engine.handleMessage(message({ payload: "OPENING_TAP:k7", timestamp: T + 10 }));
    expect(client.calls.text).toHaveLength(1);
    expect((await getConversation(db, "u1", "k7"))?.state).toBe("DONE");
    expect((await getConversation(db, "u1", "k3"))?.state).toBe("AWAITING_TAP");
  });

  // This was recorded as a DEFECT: a single typed "ok" advanced all 20 open funnels and fired 20
  // rewards in one burst, well past Instagram's per-second tolerance. It was the most extreme form
  // of the same root cause as the reported bug — a typed reply being treated as a button press.
  // Requiring the payload fixes it at the source: "ok" is now a reply to 20 funnels and a press on
  // none of them.
  it("one typed reply across 20 campaigns fires NO rewards (was: fired 20 at once)", async () => {
    for (let i = 0; i < 20; i++) {
      await upsertCampaign(db, campaign({ campaign_id: `k${i}`, media_id: `m${i}` }), true);
      await engine.handleComment(comment({ comment_id: `cm${i}`, media_id: `m${i}` }));
    }
    await engine.handleMessage(message({ text: "ok", timestamp: T + 10 }));
    expect(client.calls.text).toHaveLength(0);

    // A real press still carries exactly one campaign's tag, so it advances exactly that funnel.
    await engine.handleMessage(message({ payload: "OPENING_TAP:k7", timestamp: T + 20 }));
    expect(client.calls.text).toHaveLength(1);
    expect((await getConversation(db, "u1", "k7"))?.state).toBe("DONE");
    expect((await getConversation(db, "u1", "k3"))?.state).toBe("AWAITING_TAP");
  });
});

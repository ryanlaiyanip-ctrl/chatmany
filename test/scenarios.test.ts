// End-to-end funnel scenarios, run against the real Engine + real migrations in SQLite.
//
// Unlike the unit tests, these are written to be READ: each one prints the conversation exactly as
// the person on Instagram would experience it, then asserts what the database ended up believing.
// Run `npx vitest run scenarios --reporter=basic` to see the transcripts.

import { afterAll, describe, expect, it } from "vitest";
import { Engine } from "../src/engine/engine";
import { SendQueue } from "../src/queue/queue";
import { InstagramApiError } from "../src/api/client";
import { eventCountsByType, getConversation, isCommentProcessed, upsertCampaign } from "../src/db";
import type { Campaign, NormalizedComment, NormalizedMessage } from "../src/types";
import { makeTestDb } from "./helpers/fakeD1";
import { FakeClient } from "./helpers/fakeClient";

const out: string[] = [];
const say = (s = "") => out.push(s);
afterAll(() => console.log("\n" + out.join("\n") + "\n"));

/** Records every outbound send in order, so a scenario can be printed as a real transcript. */
class SimClient extends FakeClient {
  timeline: string[] = [];
  /** Model Instagram's real rule: a comment can be privately replied to ONCE, ever. */
  enforceOncePerComment = false;
  private repliedTo = new Set<string>();

  private async rec<T>(channel: keyof FakeClient["calls"], lines: string[], fn: () => Promise<T>): Promise<T> {
    const before = this.calls[channel].length;
    try {
      const r = await fn();
      this.timeline.push(...lines);
      return r;
    } catch (e) {
      // deliverThenFail: recorded in `calls` before throwing, i.e. it really did reach the person.
      if (this.calls[channel].length > before) {
        this.timeline.push(...lines, "        ⚠️  (delivered, but we never got confirmation)");
      }
      throw e;
    }
  }

  override async privateReplyWithButtons(commentId: string, text: string, buttons: { title: string }[]) {
    if (this.enforceOncePerComment && this.repliedTo.has(commentId)) {
      this.timeline.push(`   ↳ ✖ Instagram REJECTS: already privately replied to this comment`);
      throw new InstagramApiError("(#10903) Cannot reply privately to this comment again", 400, 10903);
    }
    const r = await this.rec("privateReply", [`   ↳ 📩 opening DM (private reply to the comment)`, `        "${text}"`, `        [ ${buttons[0]?.title} ]`], () =>
      super.privateReplyWithButtons(commentId, text, buttons),
    );
    this.repliedTo.add(commentId);
    return r;
  }
  override async sendButtonTemplate(recipient: { igsid?: string }, text: string, buttons: { title: string }[]) {
    return this.rec("button", [`   ↳ 💬 DM with button`, `        "${text}"`, `        [ ${buttons[0]?.title} ]`], () =>
      super.sendButtonTemplate(recipient, text, buttons),
    );
  }
  override async sendQuickReplies(igsid: string, text: string, qr: { content_type: string }[]) {
    return this.rec("quick", [`   ↳ 💬 DM with chip`, `        "${text}"`, `        ( ${qr[0]?.content_type} chip )`], () =>
      super.sendQuickReplies(igsid, text, qr),
    );
  }
  override async sendText(igsid: string, text: string) {
    return this.rec("text", [`   ↳ 🎁 DM`, `        "${text}"`], () => super.sendText(igsid, text));
  }
  override async replyToComment(commentId: string, message: string) {
    return this.rec("reply", [`   ↳ 💭 public reply under the comment: "${message}"`], () =>
      super.replyToComment(commentId, message),
    );
  }
}

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    campaign_id: "c1",
    name: "Guide drop",
    media_id: "reel_1",
    keywords: ["LINK"],
    exclude: [],
    reward: { type: "link", value: "https://example.com/guide" },
    copy: {
      opening: "Hey! Tap below to grab the link 👇",
      opening_button: "Send it to me",
      follow_gate: "Make sure you're following so you don't miss the next one 🙌",
      follow_button: "✅ I followed",
      email_ask: "Want it in your inbox too? Tap your email or reply with it.",
      delivery: "Here you go 🎉 {reward}",
    },
    ...over,
  };
}

/** One simulated instance: its own DB, its own Instagram, its own transcript. */
class Sim {
  db = makeTestDb();
  client = new SimClient();
  engine = new Engine(this.db, this.client as never, new SendQueue({ minIntervalMs: 0, maxRetries: 0, baseBackoffMs: 0 }));
  private clock = Math.floor(Date.now() / 1000) + 10;
  private n = 0;

  constructor(title: string, blurb: string) {
    say(`\n${"━".repeat(78)}`);
    say(`  ${title}`);
    say(`  ${blurb}`);
    say("━".repeat(78));
  }

  async campaign(c: Campaign, active = true) {
    await upsertCampaign(this.db, c, active);
    const bits = [c.check_follow ? "follow gate" : null, c.ask_email ? "email ask" : null].filter(Boolean);
    say(`  ⚙️  campaign "${c.campaign_id}" on ${c.media_id} · keyword ${c.keywords.join("/")}${bits.length ? " · " + bits.join(" + ") : ""}${active ? "" : "  [STOPPED]"}`);
  }

  /** Someone comments on a post. */
  async comments(person: string, text: string, mediaId = "reel_1", commentId?: string) {
    const id = commentId ?? `cm${++this.n}`;
    say(`\n  @${person} comments on ${mediaId}:  "${text}"`);
    const evt: NormalizedComment = {
      kind: "comment", comment_id: id, igsid: person, username: person,
      text, media_id: mediaId, timestamp: (this.clock += 5),
    };
    await this.drain(() => this.engine.handleComment(evt));
    return id;
  }

  /** The same comment being seen again by a later poll. */
  async repoll(person: string, text: string, commentId: string, mediaId = "reel_1") {
    say(`\n  ⟳ the poller re-reads @${person}'s comment "${text}" (it does this every 90s)`);
    await this.drain(() =>
      this.engine.handleComment({ kind: "comment", comment_id: commentId, igsid: person, username: person, text, media_id: mediaId, timestamp: this.clock }),
    );
  }

  /** Someone types a message. This is all polling mode can ever see. */
  async types(person: string, text: string) {
    say(`\n  @${person} types:  "${text}"`);
    await this.drain(() => this.engine.handleMessage({ kind: "message", igsid: person, text, timestamp: (this.clock += 5) }));
  }

  /** Someone taps a button, delivered as a postback payload (webhook mode only). */
  async taps(person: string, label: string, payload: string) {
    say(`\n  @${person} taps [ ${label} ]   → payload ${payload}`);
    await this.drain(() => this.engine.handleMessage({ kind: "message", igsid: person, payload, timestamp: (this.clock += 5) }));
  }

  /** Instagram's native email chip hands the address over directly. */
  async tapsEmailChip(person: string, email: string) {
    say(`\n  @${person} taps their email chip:  ${email}`);
    await this.drain(() => this.engine.handleMessage({ kind: "message", igsid: person, email, timestamp: (this.clock += 5) }));
  }

  /** A message that arrived before our last transition (a re-read of old history). */
  async stale(person: string, text: string) {
    say(`\n  @${person}'s OLD message is re-read from history:  "${text}"`);
    await this.drain(() => this.engine.handleMessage({ kind: "message", igsid: person, text, timestamp: this.clock - 1000 }));
  }

  private async drain(fn: () => Promise<void>) {
    const before = this.client.timeline.length;
    try {
      await fn();
    } catch (e) {
      say(`   ↳ ✖ threw: ${e instanceof Error ? e.message : String(e)}`);
    }
    const added = this.client.timeline.slice(before);
    if (added.length === 0) say(`   ↳ (nothing sent)`);
    else say(added.join("\n"));
  }

  async state(person: string, campaignId = "c1") {
    return (await getConversation(this.db, person, campaignId))?.state ?? null;
  }
  async counts(campaignId = "c1") {
    return eventCountsByType(this.db, campaignId, 0);
  }
  /** How many DMs this person actually received, across every channel. */
  received() {
    const c = this.client.calls;
    return c.privateReply.length + c.button.length + c.quick.length + c.text.length;
  }
  note(s: string) {
    say(`\n  → ${s}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
describe("1 · the normal path", () => {
  it("full funnel: comment → tap → follow → email → reward", async () => {
    const sim = new Sim("SCENARIO 1A — everything switched on", "The path you'd design on purpose.");
    await sim.campaign(campaign({ check_follow: true, ask_email: true }));

    await sim.comments("sara", "LINK please!");
    expect(await sim.state("sara")).toBe("AWAITING_TAP");

    await sim.types("sara", "ok");
    expect(await sim.state("sara")).toBe("AWAITING_FOLLOW");

    await sim.types("sara", "✅ I followed");
    expect(await sim.state("sara")).toBe("AWAITING_EMAIL");

    await sim.types("sara", "sara@example.com");
    expect(await sim.state("sara")).toBe("DONE");

    sim.note("4 DMs, 1 reward, funnel complete.");
    expect(await sim.counts()).toMatchObject({
      comment_matched: 1, opening_sent: 1, button_clicked: 1,
      follow_confirmed: 1, email_captured: 1, delivered: 1,
    });
  });

  it("shortest funnel: comment → tap → reward", async () => {
    const sim = new Sim("SCENARIO 1B — no follow gate, no email", "Fewest steps to the reward.");
    await sim.campaign(campaign());
    await sim.comments("mo", "link");
    await sim.types("mo", "yes");
    expect(await sim.state("mo")).toBe("DONE");
    sim.note("2 DMs total. Every extra toggle is another place people drop out.");
    expect(sim.received()).toBe(2);
  });

  it("follow gate only, and email only", async () => {
    const a = new Sim("SCENARIO 1C — follow gate, no email", "");
    await a.campaign(campaign({ check_follow: true }));
    await a.comments("ana", "LINK");
    await a.types("ana", "hi");
    await a.types("ana", "done");
    expect(await a.state("ana")).toBe("DONE");

    const b = new Sim("SCENARIO 1D — email, no follow gate", "");
    await b.campaign(campaign({ ask_email: true }));
    await b.comments("ben", "LINK");
    await b.types("ben", "hi");
    await b.types("ben", "ben@example.com");
    expect(await b.state("ben")).toBe("DONE");
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe("2 · button tap vs typed reply", () => {
  it("a real postback tap (webhook mode) advances", async () => {
    const sim = new Sim("SCENARIO 2A — tapping the button, webhook mode", "The payload identifies the tap exactly.");
    await sim.campaign(campaign({ check_follow: true }));
    await sim.comments("kit", "LINK");
    await sim.taps("kit", "Send it to me", "OPENING_TAP");
    expect(await sim.state("kit")).toBe("AWAITING_FOLLOW");
    await sim.taps("kit", "✅ I followed", "FOLLOW_CONFIRM");
    expect(await sim.state("kit")).toBe("DONE");
  });

  it("a foreign payload does NOT advance the follow gate", async () => {
    const sim = new Sim("SCENARIO 2B — some other button's payload", "Guards against unrelated events advancing the funnel.");
    await sim.campaign(campaign({ check_follow: true }));
    await sim.comments("kit", "LINK");
    await sim.types("kit", "hi");
    await sim.taps("kit", "Some other button", "SOMETHING_ELSE");
    expect(await sim.state("kit")).toBe("AWAITING_FOLLOW");
    sim.note("Correctly ignored — they stay at the gate.");
  });

  it("in polling mode any typed reply passes the gate", async () => {
    const sim = new Sim("SCENARIO 2C — polling mode, they type instead of tapping", "Polling never sees payloads, so any message counts.");
    await sim.campaign(campaign({ check_follow: true }));
    await sim.comments("lee", "LINK");
    await sim.types("lee", "hey");
    await sim.types("lee", "what is this?");
    expect(await sim.state("lee")).toBe("DONE");
    sim.note("⚠️  'what is this?' passed the follow gate and got the reward. Expected — the gate is a nudge, not a check.");
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe("3 · comments that should not trigger", () => {
  it("wrong keyword, partial word, excluded word, stopped campaign", async () => {
    const sim = new Sim("SCENARIO 3 — the four ways a comment is ignored", "Nothing should be sent in any of these.");
    await sim.campaign(campaign({ keywords: ["LINK"], exclude: ["scam"] }));

    await sim.comments("a", "love this!");
    await sim.comments("b", "blinking lights");   // 'link' inside 'blinking'
    await sim.comments("c", "LINK but this is a scam");
    expect(sim.received()).toBe(0);

    await sim.comments("d", "LINK");              // control: this one must work
    expect(sim.received()).toBe(1);
    sim.note("Whole-word matching stopped 'blinking'; the exclude list stopped the third.");
  });

  it("a stopped campaign is not polled at all", async () => {
    const sim = new Sim("SCENARIO 3B — campaign switched off", "Stopping must stop it immediately.");
    await sim.campaign(campaign(), false);
    await sim.comments("e", "LINK");
    sim.note("The poller only ever loads active campaigns, so this comment is never seen.");
    expect(sim.received()).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe("4 · the same person, more than once", () => {
  it("two comments on the SAME post = one DM", async () => {
    const sim = new Sim("SCENARIO 4A — they comment twice on one post", "Enthusiasm must not mean two DMs.");
    await sim.campaign(campaign());
    await sim.comments("dana", "LINK");
    await sim.comments("dana", "LINK please!!");
    expect(sim.received()).toBe(1);
    sim.note("Second comment matched, but they already have a conversation — no second DM.");
  });

  it("the poller re-reading a comment sends nothing new", async () => {
    const sim = new Sim("SCENARIO 4B — the same comment, polled again", "Happens every 90 seconds, forever.");
    await sim.campaign(campaign());
    const id = await sim.comments("eli", "LINK");
    await sim.repoll("eli", "LINK", id);
    await sim.repoll("eli", "LINK", id);
    expect(sim.received()).toBe(1);
  });

  it("★ comments on TWO DIFFERENT posts", async () => {
    const sim = new Sim(
      "SCENARIO 4C — ★ they comment on two different videos",
      "The case you asked about. Two posts, two separate campaigns.",
    );
    await sim.campaign(campaign({ campaign_id: "c1", media_id: "reel_1", keywords: ["LINK"] }));
    await sim.campaign(campaign({ campaign_id: "c2", media_id: "reel_2", keywords: ["GUIDE"], reward: { type: "link", value: "https://example.com/other" } }));

    await sim.comments("finn", "LINK", "reel_1");
    await sim.comments("finn", "GUIDE", "reel_2");
    sim.note("Two openings — correct. They asked for two different things.");
    expect(sim.received()).toBe(2);

    await sim.types("finn", "ok");

    const c1 = await sim.state("finn", "c1");
    const c2 = await sim.state("finn", "c2");
    sim.note(`After ONE reply:  c1 = ${c1},  c2 = ${c2}`);
    sim.note(`They received ${sim.received()} DMs total from 2 comments and 1 reply.`);

    expect(c1).toBe("DONE");
    expect(c2).toBe("DONE");
    expect(sim.received()).toBe(4);
    sim.note("⚠️  ONE reply satisfied BOTH funnels — they got both rewards, having engaged once.");
  });

  it("★ a tagged press advances ONLY the video they pressed on", async () => {
    const sim = new Sim(
      "SCENARIO 4D — ★ same thing, but they PRESS the button (webhook mode)",
      "The button now carries the campaign that sent it, so the press is unambiguous.",
    );
    await sim.campaign(campaign({ campaign_id: "c1", media_id: "reel_1", keywords: ["LINK"] }));
    await sim.campaign(campaign({ campaign_id: "c2", media_id: "reel_2", keywords: ["GUIDE"], reward: { type: "link", value: "https://example.com/other" } }));

    await sim.comments("gus", "LINK", "reel_1");
    await sim.comments("gus", "GUIDE", "reel_2");
    await sim.taps("gus", "Send it to me", "OPENING_TAP:c2");

    expect(await sim.state("gus", "c2")).toBe("DONE");
    expect(await sim.state("gus", "c1")).toBe("AWAITING_TAP");
    sim.note("✅ Only the GUIDE reward went out. The LINK funnel is untouched, still waiting for its own press.");

    await sim.taps("gus", "Send it to me", "OPENING_TAP:c1");
    expect(await sim.state("gus", "c1")).toBe("DONE");
    sim.note("✅ Pressing the other button then delivers the other reward. Two presses, two rewards.");
  });

  it("★ a legacy untagged button still works", async () => {
    const sim = new Sim(
      "SCENARIO 4D2 — ★ a button sent before tagging existed",
      "Those DMs are already in people's inboxes. They must not break.",
    );
    await sim.campaign(campaign({ campaign_id: "c1", media_id: "reel_1", keywords: ["LINK"] }));
    await sim.comments("uma", "LINK", "reel_1");
    await sim.taps("uma", "Send it to me", "OPENING_TAP"); // no campaign id — the old format
    expect(await sim.state("uma", "c1")).toBe("DONE");
    sim.note("✅ Recognised and honoured, falling back to the old advance-everything behavior.");
  });

  it("typing still advances everything, because a typed reply says nothing about which", async () => {
    const sim = new Sim(
      "SCENARIO 4D3 — they type instead of pressing",
      "The limit of the fix: text carries no campaign, so there is nothing to disambiguate with.",
    );
    await sim.campaign(campaign({ campaign_id: "c1", media_id: "reel_1", keywords: ["LINK"] }));
    await sim.campaign(campaign({ campaign_id: "c2", media_id: "reel_2", keywords: ["GUIDE"], reward: { type: "link", value: "https://example.com/other" } }));
    await sim.comments("vic", "LINK", "reel_1");
    await sim.comments("vic", "GUIDE", "reel_2");
    await sim.types("vic", "ok");
    expect(await sim.state("vic", "c1")).toBe("DONE");
    expect(await sim.state("vic", "c2")).toBe("DONE");
    sim.note("Both, as before. Only a button press can be attributed to a campaign.");
  });

  it("★ two campaigns on the SAME post, one comment matching both", async () => {
    const sim = new Sim(
      "SCENARIO 4E — ★ one comment, two campaigns on the same video",
      "Easy to set up by accident: two automations watching one post with overlapping keywords.",
    );
    await sim.campaign(campaign({ campaign_id: "c1", media_id: "reel_1", keywords: ["LINK"] }));
    await sim.campaign(campaign({ campaign_id: "c2", media_id: "reel_1", keywords: ["GUIDE"], reward: { type: "link", value: "https://example.com/other" } }));

    await sim.comments("hal", "send me the LINK and the GUIDE");
    sim.note(`One comment → ${sim.received()} opening DMs, back to back, from a single comment.`);
    expect(sim.received()).toBe(2);

    await sim.types("hal", "ok");
    sim.note(`Then one reply → ${sim.received()} DMs total.`);
    expect(await sim.state("hal", "c1")).toBe("DONE");
    expect(await sim.state("hal", "c2")).toBe("DONE");
  });

  it("★ 4E with Instagram's real once-per-comment rule applied", async () => {
    const sim = new Sim(
      "SCENARIO 4F — ★ 4E again, but Instagram enforces its actual rule",
      "A comment can be privately replied to ONCE. The second opening cannot be sent.",
    );
    sim.client.enforceOncePerComment = true;
    await sim.campaign(campaign({ campaign_id: "c1", media_id: "reel_1", keywords: ["LINK"] }));
    await sim.campaign(campaign({ campaign_id: "c2", media_id: "reel_1", keywords: ["GUIDE"], reward: { type: "link", value: "https://example.com/other" } }));

    const id = await sim.comments("ida", "send me the LINK and the GUIDE");
    expect(await sim.state("ida", "c1")).toBe("AWAITING_TAP");
    expect(await sim.state("ida", "c2")).toBeNull();
    sim.note("c1 got its DM. c2's was refused — correct so far, nothing was delivered twice.");

    // A rejection is treated as retryable, so the comment is deliberately left unprocessed.
    expect(await isCommentProcessed(sim.db, id)).toBe(false);

    for (let i = 0; i < 3; i++) await sim.repoll("ida", "send me the LINK and the GUIDE", id);

    sim.note(`After 3 more polls, comment still unprocessed: ${!(await isCommentProcessed(sim.db, id))}`);
    sim.note("⚠️  This never resolves. Instagram will refuse that second private reply forever, so the");
    sim.note("   comment is retried on EVERY poll, indefinitely — a permanent hot loop burning API calls.");
    expect(await isCommentProcessed(sim.db, id)).toBe(false);
    expect(await sim.state("ida", "c2")).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe("5 · email capture", () => {
  it("garbage, then a sentence, then a chip", async () => {
    const sim = new Sim("SCENARIO 5 — everything people actually type for an email", "");
    await sim.campaign(campaign({ ask_email: true }));
    await sim.comments("gil", "LINK");
    await sim.types("gil", "ok");

    await sim.types("gil", "why do you need that");
    expect(await sim.state("gil")).toBe("AWAITING_EMAIL");
    sim.note("Not an email → re-asked instead of going silent. Reward NOT sent.");

    await sim.types("gil", "sure it's gil@example.com ok?");
    expect(await sim.state("gil")).toBe("DONE");
    sim.note("Email pulled out of the middle of a sentence.");

    const sim2 = new Sim("SCENARIO 5B — the native email chip", "");
    await sim2.campaign(campaign({ ask_email: true }));
    await sim2.comments("hana", "LINK");
    await sim2.types("hana", "ok");
    await sim2.tapsEmailChip("hana", "hana@example.com");
    expect(await sim2.state("hana")).toBe("DONE");
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe("6 · after the funnel, and odd timing", () => {
  it("messages after delivery are ignored", async () => {
    const sim = new Sim("SCENARIO 6A — they keep talking after getting the reward", "The bot must go quiet, not loop.");
    await sim.campaign(campaign());
    await sim.comments("ivy", "LINK");
    await sim.types("ivy", "ok");
    const before = sim.received();
    await sim.types("ivy", "thanks!");
    await sim.types("ivy", "hello?");
    expect(sim.received()).toBe(before);
    sim.note("Silent, correctly. They're DONE and no longer an open conversation.");
  });

  it("old messages re-read from history do not re-fire", async () => {
    const sim = new Sim("SCENARIO 6B — poller re-reads old message history", "Every poll re-reads the last 10 messages.");
    await sim.campaign(campaign({ check_follow: true }));
    await sim.comments("jo", "LINK");
    await sim.types("jo", "ok");
    const before = sim.received();
    await sim.stale("jo", "ok");
    expect(sim.received()).toBe(before);
    sim.note("Ignored — it predates our last transition.");
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe("7 · several people at once", () => {
  it("keeps funnels independent", async () => {
    const sim = new Sim("SCENARIO 7 — three people, all mid-funnel", "State must never bleed between people.");
    await sim.campaign(campaign({ check_follow: true, ask_email: true }));
    await sim.comments("ann", "LINK");
    await sim.comments("bob", "LINK");
    await sim.comments("cal", "LINK");

    await sim.types("ann", "ok");
    await sim.types("bob", "ok");
    await sim.types("ann", "followed");
    await sim.types("ann", "ann@example.com");

    expect(await sim.state("ann")).toBe("DONE");
    expect(await sim.state("bob")).toBe("AWAITING_FOLLOW");
    expect(await sim.state("cal")).toBe("AWAITING_TAP");
    sim.note("ann finished, bob is at the gate, cal never replied. All correct.");
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe("8 · public replies", () => {
  it("posts once, never twice, even across re-polls", async () => {
    const sim = new Sim("SCENARIO 8 — public reply under the comment", "Visible to everyone, so a duplicate is embarrassing.");
    await sim.campaign(campaign({ public_reply: { enabled: true, texts: ["Sent you a DM! 📩"] } }));
    const id = await sim.comments("kim", "LINK");
    await sim.repoll("kim", "LINK", id);
    expect(sim.client.calls.reply).toHaveLength(1);
    sim.note("Exactly one public reply.");
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe("9 · when Instagram misbehaves", () => {
  it("a rejected send retries cleanly next poll", async () => {
    const sim = new Sim("SCENARIO 9A — Instagram rejects the opening DM", "Nothing was delivered, so retrying is safe.");
    await sim.campaign(campaign());
    sim.client.failNext.privateReply = 1;
    const id = await sim.comments("lex", "LINK");
    expect(await sim.state("lex")).toBeNull();
    sim.note("No conversation created, nothing logged — the lead is not lost.");

    await sim.repoll("lex", "LINK", id);
    expect(await sim.state("lex")).toBe("AWAITING_TAP");
    sim.note("Next poll retried it and it went out. One DM total, not zero, not two.");
    expect(sim.received()).toBe(1);
  });

  it("a send that delivered but reported failure is NOT sent twice", async () => {
    const sim = new Sim("SCENARIO 9B — the message landed, the connection dropped", "The case that produces real duplicate DMs.");
    await sim.campaign(campaign());
    sim.client.deliverThenFailNext.privateReply = 1;
    const id = await sim.comments("max", "LINK");
    await sim.repoll("max", "LINK", id);
    expect(sim.received()).toBe(1);
    sim.note("One DM. We assume it landed rather than risk showing it twice.");
  });
});

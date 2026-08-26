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

    await sim.taps("sara", "Send it to me", "OPENING_TAP:c1");
    expect(await sim.state("sara")).toBe("AWAITING_FOLLOW");

    await sim.taps("sara", "✅ I followed", "FOLLOW_CONFIRM:c1");
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
    await sim.taps("mo", "Send it to me", "OPENING_TAP:c1");
    expect(await sim.state("mo")).toBe("DONE");
    sim.note("2 DMs total. Every extra toggle is another place people drop out.");
    expect(sim.received()).toBe(2);
  });

  it("follow gate only, and email only", async () => {
    const a = new Sim("SCENARIO 1C — follow gate, no email", "");
    await a.campaign(campaign({ check_follow: true }));
    await a.comments("ana", "LINK");
    await a.taps("ana", "Send it to me", "OPENING_TAP:c1");
    await a.taps("ana", "✅ I followed", "FOLLOW_CONFIRM:c1");
    expect(await a.state("ana")).toBe("DONE");

    const b = new Sim("SCENARIO 1D — email, no follow gate", "");
    await b.campaign(campaign({ ask_email: true }));
    await b.comments("ben", "LINK");
    await b.taps("ben", "Send it to me", "OPENING_TAP:c1");
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
    await sim.taps("kit", "Send it to me", "OPENING_TAP:c1");
    await sim.taps("kit", "Some other button", "SOMETHING_ELSE");
    expect(await sim.state("kit")).toBe("AWAITING_FOLLOW");
    sim.note("Correctly ignored — they stay at the gate.");
  });

  it("a typed reply does NOT stand in for a press", async () => {
    const sim = new Sim(
      "SCENARIO 2C — they type instead of tapping",
      "The reported bug. Typing used to carry them through the whole funnel.",
    );
    await sim.campaign(campaign({ check_follow: true }));
    await sim.comments("lee", "LINK");
    await sim.types("lee", "hey");
    expect(await sim.state("lee")).toBe("AWAITING_TAP");
    expect(sim.received()).toBe(2); // opening + ONE re-send of the button they ignored
    sim.note("They stay put, and the button they ignored is put back in front of them. Once.");

    await sim.types("lee", "what is this?");
    await sim.types("lee", "still typing");
    expect(sim.received()).toBe(2);
    sim.note("Everything after that: nothing. One nudge per funnel is the whole budget.");

    await sim.taps("lee", "Send it to me", "OPENING_TAP:c1");
    expect(await sim.state("lee")).toBe("AWAITING_FOLLOW");
    sim.note("✅ And when they DO press it, the funnel picks up exactly where it was.");
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

    await sim.taps("finn", "Send it to me", "OPENING_TAP:c1");

    const c1 = await sim.state("finn", "c1");
    const c2 = await sim.state("finn", "c2");
    sim.note(`After ONE press:  c1 = ${c1},  c2 = ${c2}`);
    sim.note(`They received ${sim.received()} DMs total from 2 comments and 1 press.`);

    expect(c1).toBe("DONE");
    expect(c2).toBe("AWAITING_TAP");
    expect(sim.received()).toBe(3);
    sim.note("✅ One press, one reward. The GUIDE funnel still waits for its own button.");
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

  it("typing advances NOTHING, so there is nothing to disambiguate", async () => {
    const sim = new Sim(
      "SCENARIO 4D3 — they type instead of pressing",
      "Text carries no campaign — but it is also no longer a press, so the ambiguity never arises.",
    );
    await sim.campaign(campaign({ campaign_id: "c1", media_id: "reel_1", keywords: ["LINK"] }));
    await sim.campaign(campaign({ campaign_id: "c2", media_id: "reel_2", keywords: ["GUIDE"], reward: { type: "link", value: "https://example.com/other" } }));
    await sim.comments("vic", "LINK", "reel_1");
    await sim.comments("vic", "GUIDE", "reel_2");
    await sim.types("vic", "ok");
    expect(await sim.state("vic", "c1")).toBe("AWAITING_TAP");
    expect(await sim.state("vic", "c2")).toBe("AWAITING_TAP");
    sim.note("Neither. A typed reply is not a press, so no reward goes out and nothing is guessed at.");
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

    await sim.taps("hal", "Send it to me", "OPENING_TAP:c1");
    sim.note(`Then one PRESS → ${sim.received()} DMs total.`);
    expect(await sim.state("hal", "c1")).toBe("DONE");
    expect(await sim.state("hal", "c2")).toBe("AWAITING_TAP");
    sim.note("Only the funnel whose button they actually pressed. The other still waits for its own.");
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
    await sim.taps("gil", "Send it to me", "OPENING_TAP:c1");

    await sim.types("gil", "why do you need that");
    expect(await sim.state("gil")).toBe("AWAITING_EMAIL");
    sim.note("Not an email → re-asked instead of going silent. Reward NOT sent.");

    await sim.types("gil", "sure it's gil@example.com ok?");
    expect(await sim.state("gil")).toBe("DONE");
    sim.note("Email pulled out of the middle of a sentence.");

    const sim2 = new Sim("SCENARIO 5B — the native email chip", "");
    await sim2.campaign(campaign({ ask_email: true }));
    await sim2.comments("hana", "LINK");
    await sim2.taps("hana", "Send it to me", "OPENING_TAP:c1");
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
    await sim.taps("ivy", "Send it to me", "OPENING_TAP:c1");
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

    await sim.taps("ann", "Send it to me", "OPENING_TAP:c1");
    await sim.taps("bob", "Send it to me", "OPENING_TAP:c1");
    await sim.taps("ann", "✅ I followed", "FOLLOW_CONFIRM:c1");
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

// ────────────────────────────────────────────────────────────────────────────
// Everything here is ONE person with SEVERAL funnels open at once — the case that arises the
// moment somebody comments on a second post without finishing the first. It matters more than it
// looks, because all of a person's campaigns share a SINGLE Instagram DM thread: two funnels
// reacting to one message means two DMs arriving back to back in that one thread.
describe("10 · one person, several posts, nothing pressed", () => {
  const twoPosts = async (sim: Sim) => {
    await sim.campaign(campaign({ campaign_id: "c1", media_id: "reel_1", keywords: ["LINK"] }));
    await sim.campaign(campaign({
      campaign_id: "c2", media_id: "reel_2", keywords: ["GUIDE"],
      reward: { type: "link", value: "https://example.com/other" },
    }));
  };

  it("★ comments on one, ignores the button, comments on another, then types", async () => {
    const sim = new Sim(
      "SCENARIO 10A — ★ two posts, no presses, then a typed message",
      "One thread, two open funnels. The reply must not become two DMs.",
    );
    await twoPosts(sim);
    await sim.comments("noa", "LINK", "reel_1");
    await sim.comments("noa", "GUIDE", "reel_2");
    expect(sim.received()).toBe(2); // one opening each — correct, they asked for two things

    await sim.types("noa", "hey");
    expect(sim.received()).toBe(3);
    sim.note("ONE nudge, not one per funnel. Two would have landed back to back in the same thread.");

    expect(await sim.state("noa", "c1")).toBe("AWAITING_TAP");
    expect(await sim.state("noa", "c2")).toBe("AWAITING_TAP");
    sim.note("Neither funnel moved — they still have not pressed anything.");
  });

  it("★ keeps replying without ever pressing: at most one DM per message they send", async () => {
    const sim = new Sim(
      "SCENARIO 10B — ★ they keep typing, two funnels open",
      "The bound that matters: one inbound message can never produce more than one DM.",
    );
    await twoPosts(sim);
    await sim.comments("owen", "LINK", "reel_1");
    await sim.comments("owen", "GUIDE", "reel_2");
    const afterOpenings = sim.received();

    for (const t of ["hey", "hello?", "anyone", "??", "still here", "hello"]) await sim.types("owen", t);

    const nudges = sim.received() - afterOpenings;
    sim.note(`6 messages → ${nudges} nudge DMs. Never more than one per message, and it stops.`);
    expect(nudges).toBeLessThanOrEqual(6);
    expect(nudges).toBe(2); // two funnels × a cap of one, then silence
    await sim.types("owen", "and again");
    expect(sim.received() - afterOpenings).toBe(2);
    sim.note("Past the cap on both funnels it goes quiet, however long they keep talking.");
  });

  it("★ pressing the SECOND post's button delivers only that reward", async () => {
    const sim = new Sim(
      "SCENARIO 10C — ★ they finally press, on the second post",
      "The press names its campaign, so the other funnel is untouched.",
    );
    await twoPosts(sim);
    await sim.comments("pia", "LINK", "reel_1");
    await sim.comments("pia", "GUIDE", "reel_2");
    await sim.types("pia", "what is this");

    await sim.taps("pia", "Send it to me", "OPENING_TAP:c2");
    expect(await sim.state("pia", "c2")).toBe("DONE");
    expect(await sim.state("pia", "c1")).toBe("AWAITING_TAP");
    sim.note("✅ GUIDE delivered. The LINK funnel still waits for its own button — no free reward.");
  });

  it("★ a typed email goes to the funnel actually waiting for one, not the one waiting for a tap", async () => {
    const sim = new Sim(
      "SCENARIO 10D — ★ funnels at different depths",
      "Order matters: the deepest funnel sees the message first, so the address is not wasted.",
    );
    await sim.campaign(campaign({ campaign_id: "c1", media_id: "reel_1", keywords: ["LINK"] }));
    await sim.campaign(campaign({
      campaign_id: "c2", media_id: "reel_2", keywords: ["GUIDE"], ask_email: true,
      reward: { type: "link", value: "https://example.com/other" },
    }));
    await sim.comments("quinn", "LINK", "reel_1");   // stays at the tap
    await sim.comments("quinn", "GUIDE", "reel_2");
    await sim.taps("quinn", "Send it to me", "OPENING_TAP:c2"); // c2 advances to the email ask

    await sim.tapsEmailChip("quinn", "quinn@example.com");
    expect(await sim.state("quinn", "c2")).toBe("DONE");
    sim.note("✅ The address landed on the funnel that asked for it, and the reward went out.");
    expect(await sim.state("quinn", "c1")).toBe("AWAITING_TAP");
  });

  it("★ a non-email reply is answered once, by the deepest funnel", async () => {
    const sim = new Sim(
      "SCENARIO 10E — ★ they reply with something that is not an address",
      "Two funnels could both react. Only one is allowed to.",
    );
    await sim.campaign(campaign({ campaign_id: "c1", media_id: "reel_1", keywords: ["LINK"] }));
    await sim.campaign(campaign({
      campaign_id: "c2", media_id: "reel_2", keywords: ["GUIDE"], ask_email: true,
      reward: { type: "link", value: "https://example.com/other" },
    }));
    await sim.comments("rae", "LINK", "reel_1");
    await sim.comments("rae", "GUIDE", "reel_2");
    await sim.taps("rae", "Send it to me", "OPENING_TAP:c2");
    const before = sim.received();

    await sim.types("rae", "why do you need that");
    expect(sim.received()).toBe(before + 1);
    sim.note("One DM: the email step re-asked. The tap funnel stayed quiet rather than piling on.");
    expect(await sim.state("rae", "c2")).toBe("AWAITING_EMAIL");
    expect(await sim.state("rae", "c1")).toBe("AWAITING_TAP");
  });

  it("★ one address still completes TWO funnels that both asked for it", async () => {
    const sim = new Sim(
      "SCENARIO 10F — ★ two funnels both waiting on an email",
      "Capping NUDGES must not cap real progress — they pressed both buttons and earned both.",
    );
    await sim.campaign(campaign({ campaign_id: "c1", media_id: "reel_1", keywords: ["LINK"], ask_email: true }));
    await sim.campaign(campaign({
      campaign_id: "c2", media_id: "reel_2", keywords: ["GUIDE"], ask_email: true,
      reward: { type: "link", value: "https://example.com/other" },
    }));
    await sim.comments("sam", "LINK", "reel_1");
    await sim.comments("sam", "GUIDE", "reel_2");
    await sim.taps("sam", "Send it to me", "OPENING_TAP:c1");
    await sim.taps("sam", "Send it to me", "OPENING_TAP:c2");

    await sim.tapsEmailChip("sam", "sam@example.com");
    expect(await sim.state("sam", "c1")).toBe("DONE");
    expect(await sim.state("sam", "c2")).toBe("DONE");
    sim.note("✅ Both rewards. Progress is earned by their own presses, so it is never rationed.");
  });

  it("★ a funnel they already finished does not react to the next post's messages", async () => {
    const sim = new Sim(
      "SCENARIO 10G — ★ they completed one post, then commented on another",
      "A finished funnel must be genuinely finished, not a source of extra DMs forever.",
    );
    await twoPosts(sim);
    await sim.comments("tess", "LINK", "reel_1");
    await sim.taps("tess", "Send it to me", "OPENING_TAP:c1");
    expect(await sim.state("tess", "c1")).toBe("DONE");

    await sim.comments("tess", "GUIDE", "reel_2");
    const before = sim.received();
    await sim.types("tess", "hey");
    expect(sim.received()).toBe(before + 1);
    sim.note("One nudge, for the open funnel only. The finished one stays silent for good.");
    expect(await sim.state("tess", "c1")).toBe("DONE");
    expect(await sim.state("tess", "c2")).toBe("AWAITING_TAP");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Reproductions of real threads from production, 2026-08-26. Pressing a postback button does not
// only deliver a postback: Instagram ALSO posts the button's label into the thread as a message
// from that person. One press, two inbound events. Requiring the payload turned that second event
// into "they typed something", so the bot answered a press by re-sending the button they had just
// pressed — and when the echo won the race it also stamped updated_at over the real press, burying
// it, which is why people ended up pressing "✅ I followed" twice.
describe("11 · the button-label echo (production regressions)", () => {
  const gated = (sim: Sim) => sim.campaign(campaign({ check_follow: true }));

  it("★ @mannoeglainfit — one tap must not produce three follow gates", async () => {
    const sim = new Sim(
      "SCENARIO 11A — ★ press, then the echo arrives (twice, push + poll)",
      "Shipped behavior sent the gate 3x. follow_retries hit 2 in production.",
    );
    await gated(sim);
    await sim.comments("manno", "LINK");
    await sim.taps("manno", "Send it to me", "OPENING_TAP:c1");
    expect(await sim.state("manno")).toBe("AWAITING_FOLLOW");
    const afterGate = sim.received();

    // The same press, echoed as plain text — once by the webhook, once by the poller underneath.
    await sim.types("manno", "Send it to me");
    await sim.types("manno", "Send it to me");

    expect(sim.received()).toBe(afterGate);
    sim.note("✅ Both echoes ignored. Exactly ONE follow gate, where production sent three.");
    const convo = await getConversation(sim.db, "manno", "c1");
    expect(convo?.follow_retries).toBe(0);
  });

  it("★ @elamelek.25 — the echo must not bury the real press", async () => {
    const sim = new Sim(
      "SCENARIO 11B — ★ the echo arrives BEFORE the postback",
      "The nastiest form: the echo nudged AND stamped updated_at, so the real press was dropped as stale.",
    );
    await gated(sim);
    await sim.comments("ela", "LINK");
    await sim.taps("ela", "Send it to me", "OPENING_TAP:c1");
    const afterGate = sim.received();

    // They press "✅ I followed". Its label echo lands first...
    await sim.types("ela", "✅ I followed");
    expect(sim.received()).toBe(afterGate);
    expect(await sim.state("ela")).toBe("AWAITING_FOLLOW");
    sim.note("Echo ignored — no gate re-sent, and crucially updated_at was NOT touched.");

    // ...so the postback that follows it still counts, first time.
    await sim.taps("ela", "✅ I followed", "FOLLOW_CONFIRM:c1");
    expect(await sim.state("ela")).toBe("DONE");
    sim.note("✅ Delivered on the FIRST press. Production made them press it twice.");
  });

  it("★ @ryanip.life — a real typed reply still gets exactly one nudge", async () => {
    const sim = new Sim(
      "SCENARIO 11C — ★ genuinely typed messages, not echoes",
      "Suppressing echoes must not suppress the nudge for someone actually talking.",
    );
    await sim.campaign(campaign());
    await sim.comments("ryan", "LINK");
    const afterOpening = sim.received();

    for (const t of ["Hs", "He", "Haha", "Hello"]) await sim.types("ryan", t);

    expect(sim.received()).toBe(afterOpening + 1);
    sim.note("4 typed messages → ONE nudge. Production sent two identical cards.");
    expect(await sim.state("ryan")).toBe("AWAITING_TAP");
  });

  it("★ an echo is still ignored when it is the only thing that ever arrives", async () => {
    const sim = new Sim(
      "SCENARIO 11D — ★ echo with no postback behind it",
      "Ignoring costs nothing: the button is still in the transcript and a real press still works.",
    );
    await gated(sim);
    await sim.comments("tam", "LINK");
    const afterOpening = sim.received();
    await sim.types("tam", "Send it to me");
    expect(sim.received()).toBe(afterOpening);
    expect(await sim.state("tam")).toBe("AWAITING_TAP");

    await sim.taps("tam", "Send it to me", "OPENING_TAP:c1");
    expect(await sim.state("tam")).toBe("AWAITING_FOLLOW");
    sim.note("✅ Their press still works whenever it lands.");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// The case Ryan asked for directly: comment on one video, ignore its button, comment on a second,
// then press one of them. Both orderings, and with per-campaign button labels as well as shared
// ones — the label echo names no campaign, so a differing label used to make one press look like a
// typed reply to the OTHER funnel.
describe("12 · two videos, one press", () => {
  const setup = async (sim: Sim, sameLabels: boolean) => {
    await sim.campaign(campaign({
      campaign_id: "c1", media_id: "reel_1", keywords: ["LINK"], check_follow: true,
    }));
    await sim.campaign(campaign({
      campaign_id: "c2", media_id: "reel_2", keywords: ["GUIDE"], check_follow: true,
      reward: { type: "link", value: "https://example.com/other" },
      copy: {
        ...campaign().copy,
        opening_button: sameLabels ? "Send it to me" : "Get the guide",
        follow_button: sameLabels ? "✅ I followed" : "✅ Done",
      },
    }));
  };

  /** A press as Instagram really delivers it: the postback, then its label echoed as a message. */
  const press = async (sim: Sim, who: string, label: string, payload: string) => {
    await sim.taps(who, label, payload);
    await sim.types(who, label); // the echo — the bubble they never typed
  };

  it("★ ignores video 1's button, comments on video 2, presses VIDEO 2", async () => {
    const sim = new Sim("SCENARIO 12A — ★ presses the second video's button", "Only that funnel may move.");
    await setup(sim, true);
    await sim.comments("ada", "LINK", "reel_1");
    await sim.comments("ada", "GUIDE", "reel_2");
    const afterOpenings = sim.received();

    await press(sim, "ada", "Send it to me", "OPENING_TAP:c2");
    expect(sim.received()).toBe(afterOpenings + 1); // the gate, and nothing else
    expect(await sim.state("ada", "c2")).toBe("AWAITING_FOLLOW");
    expect(await sim.state("ada", "c1")).toBe("AWAITING_TAP");
    expect((await getConversation(sim.db, "ada", "c1"))?.tap_retries).toBe(0);
    sim.note("✅ Video 1 untouched — not advanced, not nudged, no re-send spent on it.");

    await press(sim, "ada", "✅ I followed", "FOLLOW_CONFIRM:c2");
    expect(await sim.state("ada", "c2")).toBe("DONE");
    expect(await sim.state("ada", "c1")).toBe("AWAITING_TAP");
    sim.note("✅ One reward, for the video they actually pressed on. First press, no repeats.");
  });

  it("★ ignores video 1's button, comments on video 2, then presses VIDEO 1", async () => {
    const sim = new Sim("SCENARIO 12B — ★ goes back and presses the first video's button", "The older funnel still works.");
    await setup(sim, true);
    await sim.comments("ben", "LINK", "reel_1");
    await sim.comments("ben", "GUIDE", "reel_2");
    const afterOpenings = sim.received();

    await press(sim, "ben", "Send it to me", "OPENING_TAP:c1");
    expect(sim.received()).toBe(afterOpenings + 1);
    expect(await sim.state("ben", "c1")).toBe("AWAITING_FOLLOW");
    expect(await sim.state("ben", "c2")).toBe("AWAITING_TAP");

    await press(sim, "ben", "✅ I followed", "FOLLOW_CONFIRM:c1");
    expect(await sim.state("ben", "c1")).toBe("DONE");
    expect(await sim.state("ben", "c2")).toBe("AWAITING_TAP");
    sim.note("✅ Scrolling back up to the older button still completes that funnel, and only it.");
  });

  it("★ same thing when the two videos use DIFFERENT button labels", async () => {
    const sim = new Sim(
      "SCENARIO 12C — ★ per-campaign button labels",
      "The echo names no campaign, so a differing label made one press read as a typed reply to the other funnel.",
    );
    await setup(sim, false);
    await sim.comments("cleo", "LINK", "reel_1");
    await sim.comments("cleo", "GUIDE", "reel_2");
    const afterOpenings = sim.received();

    await press(sim, "cleo", "Get the guide", "OPENING_TAP:c2");
    expect(sim.received()).toBe(afterOpenings + 1);
    sim.note("✅ One DM. Before this was matched thread-wide, video 1 was nudged by video 2's echo.");
    expect(await sim.state("cleo", "c1")).toBe("AWAITING_TAP");
    expect((await getConversation(sim.db, "cleo", "c1"))?.tap_retries).toBe(0);

    await press(sim, "cleo", "✅ Done", "FOLLOW_CONFIRM:c2");
    expect(await sim.state("cleo", "c2")).toBe("DONE");
    expect((await getConversation(sim.db, "cleo", "c1"))?.tap_retries).toBe(0);
    sim.note("✅ Video 1 still has its full nudge budget intact — it was never spoken to.");
  });

  it("★ and they finish BOTH videos, one press each", async () => {
    const sim = new Sim("SCENARIO 12D — ★ both funnels completed", "Two presses, two rewards, no crossfire.");
    await setup(sim, true);
    await sim.comments("dev", "LINK", "reel_1");
    await sim.comments("dev", "GUIDE", "reel_2");

    await press(sim, "dev", "Send it to me", "OPENING_TAP:c1");
    await press(sim, "dev", "✅ I followed", "FOLLOW_CONFIRM:c1");
    expect(await sim.state("dev", "c1")).toBe("DONE");

    await press(sim, "dev", "Send it to me", "OPENING_TAP:c2");
    await press(sim, "dev", "✅ I followed", "FOLLOW_CONFIRM:c2");
    expect(await sim.state("dev", "c2")).toBe("DONE");
    sim.note("✅ Both rewards, each earned by its own press.");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// A sweep of the cases nothing else covered. Two of these were failing when written: a double-tap
// produced two follow gates, and a foreign button payload arriving at the email step drew an email
// re-ask. Both were the same shape — a payload that is not the one we are waiting for still drew a
// send — which is now impossible: only a TYPED reply can ever produce a nudge.
describe("13 · duplicate presses and stray payloads", () => {
  const gated = (sim: Sim) => sim.campaign(campaign({ check_follow: true }));

  it("★ double-tapping the button sends ONE gate, not two", async () => {
    const sim = new Sim("SCENARIO 13A — ★ they tap twice, impatiently", "People double-tap. Meta also re-delivers.");
    await gated(sim);
    await sim.comments("iris", "LINK");
    const afterOpening = sim.received();

    await sim.taps("iris", "Send it to me", "OPENING_TAP:c1");
    await sim.taps("iris", "Send it to me", "OPENING_TAP:c1");

    expect(sim.received()).toBe(afterOpening + 1);
    sim.note("✅ One gate. The second press is silent — the gate is already the newest message.");
    expect((await getConversation(sim.db, "iris", "c1"))?.follow_retries).toBe(0);
  });

  it("★ a stray button from another app draws nothing, at every step", async () => {
    const sim = new Sim("SCENARIO 13B — ★ someone else's postback reaches this account", "Never our event, never our send.");
    await sim.campaign(campaign({ check_follow: true, ask_email: true }));
    await sim.comments("jan", "LINK");

    let seen = sim.received();
    await sim.taps("jan", "Some other app", "SOMEONE_ELSES_BUTTON");
    expect(sim.received()).toBe(seen); // at AWAITING_TAP

    await sim.taps("jan", "Send it to me", "OPENING_TAP:c1");
    seen = sim.received();
    await sim.taps("jan", "Some other app", "SOMEONE_ELSES_BUTTON");
    expect(sim.received()).toBe(seen); // at AWAITING_FOLLOW

    await sim.taps("jan", "✅ I followed", "FOLLOW_CONFIRM:c1");
    seen = sim.received();
    await sim.taps("jan", "Some other app", "SOMEONE_ELSES_BUTTON");
    expect(sim.received()).toBe(seen); // at AWAITING_EMAIL — the step that used to answer it
    expect((await getConversation(sim.db, "jan", "c1"))?.email_retries).toBe(0);
    sim.note("✅ Silent in all three waiting states. The email step used to re-ask off the back of it.");
  });

  it("★ pressing an old button after the funnel is finished does nothing", async () => {
    const sim = new Sim("SCENARIO 13C — ★ they scroll up and press again, weeks later", "DONE has to mean done.");
    await sim.campaign(campaign());
    await sim.comments("kai", "LINK");
    await sim.taps("kai", "Send it to me", "OPENING_TAP:c1");
    expect(await sim.state("kai")).toBe("DONE");
    const afterReward = sim.received();

    await sim.taps("kai", "Send it to me", "OPENING_TAP:c1");
    await sim.types("kai", "Send it to me");
    expect(sim.received()).toBe(afterReward);
    sim.note("✅ No second reward, no nudge. They are finished.");
  });

  it("★ an over-long label is trimmed on the way out, and its echo still matches", async () => {
    const sim = new Sim(
      "SCENARIO 13D — ★ a label past Instagram's 20-character limit",
      "The echo comes back as the TRIMMED text, so echo-matching has to compare against what was sent.",
    );
    await sim.campaign(campaign({
      copy: { ...campaign().copy, opening_button: "Tap this button right here to get it" },
    }));
    await sim.comments("liv", "LINK");
    const sent = (sim.client.calls.privateReply[0] as { buttons: { title: string }[] }).buttons[0]!.title;
    expect(sent).toBe("Tap this button righ");
    const afterOpening = sim.received();

    await sim.types("liv", sent);
    expect(sim.received()).toBe(afterOpening);
    expect((await getConversation(sim.db, "liv", "c1"))?.tap_retries).toBe(0);
    sim.note("✅ Recognised as the echo of our own button despite being cut mid-word.");
  });

  it("★ a long replay of old history produces one nudge, not forty", async () => {
    const sim = new Sim("SCENARIO 13E — ★ the poller re-reads a whole backlog", "A cursor reset must not become a DM storm.");
    await sim.campaign(campaign());
    await sim.comments("mo", "LINK");
    const afterOpening = sim.received();
    for (let i = 0; i < 40; i++) await sim.types("mo", `backlog ${i}`);
    expect(sim.received()).toBe(afterOpening + 1);
    sim.note("✅ 40 messages, one nudge. The cap and the one-per-message budget both hold.");
  });
});

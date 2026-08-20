// Deploying is two steps — migrate the database, then publish the code — and the order is not a
// style choice. These tests pin down what each ordering actually does, because the wrong one fails
// silently rather than loudly, and silence is what makes it expensive.

import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine/engine";
import { SendQueue } from "../src/queue/queue";
import { getConversation, upsertCampaign } from "../src/db";
import type { Campaign, NormalizedComment, NormalizedMessage } from "../src/types";
import { applyMigration, makeTestDbWithHandle, migrationFiles } from "./helpers/fakeD1";
import { FakeClient } from "./helpers/fakeClient";

const T = Math.floor(Date.now() / 1000);
const fast = () => new SendQueue({ minIntervalMs: 0, maxRetries: 0, baseBackoffMs: 0 });

/** The migration before the newest one — i.e. what a deployment that has not been updated looks like. */
const PREVIOUS = migrationFiles().at(-2)!.replace(/\.sql$/, "");
const LATEST = migrationFiles().at(-1)!;

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    campaign_id: "c1", media_id: "m1", keywords: ["LINK"], exclude: [],
    reward: { type: "link", value: "https://x.com/g" },
    copy: { opening: "tap", opening_button: "Go", delivery: "here {reward}" },
    ...over,
  };
}
const comment = (o: Partial<NormalizedComment> = {}): NormalizedComment =>
  ({ kind: "comment", comment_id: "cm1", igsid: "u1", username: "u1", text: "LINK", media_id: "m1", timestamp: T, ...o });
const msg = (o: Partial<NormalizedMessage> = {}): NormalizedMessage =>
  ({ kind: "message", igsid: "u1", timestamp: T + 100, ...o });

/**
 * Insert a conversation the way the PREVIOUS schema did.
 * Deliberately raw rather than via createConversation: that helper belongs to the new code and
 * names the new column, so it cannot write to the schema we are pretending is already deployed.
 */
function seedOldRow(raw: ReturnType<typeof makeTestDbWithHandle>["raw"], igsid: string, state: string, at = T - 600) {
  raw.prepare(
    `INSERT INTO conversations (igsid, campaign_id, state, username, followed, follow_retries, updated_at, created_at)
     VALUES (?, 'c1', ?, ?, 0, 0, ?, ?)`,
  ).run(igsid, state, igsid, at, at);
}

describe("migrating an existing database", () => {
  it("rows written by the previous schema survive, and pick up the new column's default", async () => {
    const { db, raw } = makeTestDbWithHandle(PREVIOUS);
    await upsertCampaign(db, campaign(), true);
    for (const [igsid, state] of [["a", "AWAITING_TAP"], ["b", "AWAITING_FOLLOW"], ["c", "DONE"]] as const) {
      seedOldRow(raw, igsid, state);
    }
    const before = raw.prepare("SELECT igsid, state, updated_at FROM conversations ORDER BY igsid").all();

    applyMigration(raw, LATEST);

    const after = raw.prepare("SELECT igsid, state, updated_at, email_retries FROM conversations ORDER BY igsid").all() as Array<Record<string, unknown>>;
    expect(after).toHaveLength(before.length);
    after.forEach((row, i) => {
      const was = before[i] as Record<string, unknown>;
      expect(row.state).toBe(was.state);        // nobody moved
      expect(row.updated_at).toBe(was.updated_at); // nobody's clock was touched
      expect(row.email_retries).toBe(0);        // and everyone picked up the default
    });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM conversations WHERE email_retries IS NULL").get()).toMatchObject({ n: 0 });
  });

  it("people mid-funnel still complete afterwards, and nobody is messaged twice", async () => {
    const { db, raw } = makeTestDbWithHandle(PREVIOUS);
    const client = new FakeClient();
    await upsertCampaign(db, campaign({ check_follow: true }), true);
    const engine = new Engine(db, client as never, fast());

    // They were sent their opening by the OLD code, and are sitting in AWAITING_TAP.
    seedOldRow(raw, "u1", "AWAITING_TAP");
    applyMigration(raw, LATEST); // ← the deploy's migration

    // The button already in their inbox carries an untagged payload; it must still work.
    await engine.handleMessage(msg({ payload: "OPENING_TAP" }));
    await db.prepare("UPDATE conversations SET updated_at = ?").bind(T - 600).run();
    await engine.handleMessage(msg({ timestamp: T + 200, payload: "FOLLOW_CONFIRM" }));

    expect((await getConversation(db, "u1", "c1"))?.state).toBe("DONE");
    const sends = [...client.calls.button, ...client.calls.text];
    expect(sends).toHaveLength(2); // gate, then delivery — one each, no repeats
  });
});

describe("deploying BEFORE migrating — why the order matters", () => {
  it("the person is DMed and then lost: no funnel row, and the comment retries forever", async () => {
    const { db, raw } = makeTestDbWithHandle(PREVIOUS); // new code, old schema
    const client = new FakeClient();
    await upsertCampaign(db, campaign(), true);
    const engine = new Engine(db, client as never, fast());

    for (let tick = 0; tick < 3; tick++) {
      await expect(engine.handleComment(comment())).rejects.toThrow(/email_retries/);
    }

    // They received exactly one DM — so from their side the automation looks like it worked...
    expect(client.calls.privateReply).toHaveLength(1);
    // ...but nothing recorded them, so tapping the button can never advance anything,
    // and the comment is never marked processed, so every poll retries it forever.
    expect(raw.prepare("SELECT COUNT(*) AS n FROM conversations").get()).toMatchObject({ n: 0 });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM processed_comments").get()).toMatchObject({ n: 0 });

    await engine.handleMessage(msg({ payload: "OPENING_TAP" }));
    expect(client.calls.privateReply).toHaveLength(1); // still nothing; they are stranded
  });

  it("existing conversations are unaffected — the damage is confined to new leads", async () => {
    const { db, raw } = makeTestDbWithHandle(PREVIOUS);
    const client = new FakeClient();
    await upsertCampaign(db, campaign(), true);
    seedOldRow(raw, "u1", "AWAITING_TAP");

    const engine = new Engine(db, client as never, fast());
    await engine.handleMessage(msg({ payload: "OPENING_TAP" }));
    expect((await getConversation(db, "u1", "c1"))?.state).toBe("DONE");
    expect(client.calls.text).toHaveLength(1);
  });
});

describe("migrating BEFORE deploying — always safe", () => {
  it("the migration is additive, so a database ahead of the code changes nothing", async () => {
    const { db, raw } = makeTestDbWithHandle(); // fully migrated
    const client = new FakeClient();
    await upsertCampaign(db, campaign(), true);
    await new Engine(db, client as never, fast()).handleComment(comment());

    const row = raw.prepare("SELECT email_retries FROM conversations WHERE igsid = 'u1'").get();
    expect(row).toMatchObject({ email_retries: 0 });
    expect(client.calls.privateReply).toHaveLength(1);
  });
});

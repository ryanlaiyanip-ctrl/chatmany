// The push path (routes/webhook.ts). This is how delivery becomes instant, so the properties here
// are the ones most worth protecting:
//
//   1. A pushed event is dispatched to the engine regardless of MODE. MODE governs the cron only.
//      Gating this route on MODE would silently turn instant delivery back into poll-speed.
//   2. An unsigned, mis-signed, or tampered request is refused and reaches no engine.
//   3. One event that throws never blocks the others in the same batch.
//
// buildRuntime is stubbed, so nothing here can reach the network.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../src/engine/engine";
import { SendQueue } from "../src/queue/queue";
import { upsertCampaign } from "../src/db";
import type { Campaign, Env } from "../src/types";
import { makeTestDb } from "./helpers/fakeD1";
import { FakeClient } from "./helpers/fakeClient";

let runtime: unknown = null;
vi.mock("../src/runtime", async (orig) => {
  const actual = await orig<typeof import("../src/runtime")>();
  return { ...actual, buildRuntime: vi.fn(async () => runtime) };
});

const { handleWebhookEvent, handleWebhookVerify, handleWebhookAdmin } = await import("../src/routes/webhook");

const APP_SECRET = "test-app-secret";
const T = Math.floor(Date.now() / 1000);

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    campaign_id: "c1", media_id: "m1", keywords: ["LINK"], exclude: [],
    reward: { type: "link", value: "https://x.com/g" },
    copy: { opening: "tap", opening_button: "Go", delivery: "here {reward}" },
    ...over,
  };
}

async function sign(raw: string, secret = APP_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const post = (body: string, sig?: string) =>
  new Request("https://example.test/webhook", {
    method: "POST", body,
    headers: sig ? { "x-hub-signature-256": sig, "content-type": "application/json" } : {},
  });

/** A messaging event as Meta pushes it: a typed DM carries no payload, a press carries one. */
const typedPush = (text: string, from = "uW") => ({
  entry: [{ messaging: [{ sender: { id: from }, timestamp: (T + 10) * 1000, message: { text } }] }],
});
const pressPush = (payload: string, from = "uW") => ({
  entry: [{ messaging: [{ sender: { id: from }, timestamp: (T + 20) * 1000, postback: { payload, title: "Go" } }] }],
});

const commentPush = (id = "cmW", from = "uW") => ({
  entry: [{ changes: [{ field: "comments", value: {
    id, text: "LINK please", timestamp: new Date(T * 1000).toISOString(),
    from: { id: from, username: "w" }, media: { id: "m1" } } }] }],
});

let client: FakeClient;
async function envFor(mode: string): Promise<Env> {
  const db = makeTestDb();
  client = new FakeClient();
  await upsertCampaign(db, campaign(), true);
  runtime = {
    engine: new Engine(db, client as never, new SendQueue({ minIntervalMs: 0, maxRetries: 0, baseBackoffMs: 0 })),
    igUserId: "me",
  };
  return { DB: db, MODE: mode, APP_SECRET, WEBHOOK_VERIFY_TOKEN: "vtok" } as unknown as Env;
}

beforeEach(() => { runtime = null; });

describe("MODE does not gate the push path", () => {
  it.each(["polling", "webhook"])('a signed comment event is dispatched with MODE=%s', async (mode) => {
    const env = await envFor(mode);
    const raw = JSON.stringify(commentPush());
    const res = await handleWebhookEvent(env, post(raw, await sign(raw)));
    expect(res.status).toBe(200);
    // The opening DM went out — the whole point of push being instant.
    expect(client.calls.privateReply).toHaveLength(1);
  });

  it("polling mode is not merely accepted — it produces the identical send", async () => {
    const raw = JSON.stringify(commentPush());
    const envA = await envFor("polling");
    await handleWebhookEvent(envA, post(raw, await sign(raw)));
    const polling = JSON.stringify(client.calls.privateReply);
    const envB = await envFor("webhook");
    await handleWebhookEvent(envB, post(raw, await sign(raw)));
    expect(JSON.stringify(client.calls.privateReply)).toBe(polling);
  });
});

describe("signature verification", () => {
  it("refuses an unsigned request", async () => {
    const env = await envFor("polling");
    const res = await handleWebhookEvent(env, post(JSON.stringify(commentPush())));
    expect(res.status).toBe(401);
    expect(client.calls.privateReply).toHaveLength(0);
  });

  it("refuses a mis-signed request", async () => {
    const env = await envFor("polling");
    const res = await handleWebhookEvent(env, post(JSON.stringify(commentPush()), "sha256=deadbeef"));
    expect(res.status).toBe(401);
    expect(client.calls.privateReply).toHaveLength(0);
  });

  it("refuses a request signed with the wrong secret", async () => {
    const env = await envFor("polling");
    const raw = JSON.stringify(commentPush());
    const res = await handleWebhookEvent(env, post(raw, await sign(raw, "not-the-secret")));
    expect(res.status).toBe(401);
    expect(client.calls.privateReply).toHaveLength(0);
  });

  it("refuses a tampered body carrying a signature valid for the original", async () => {
    const env = await envFor("polling");
    const raw = JSON.stringify(commentPush());
    const sig = await sign(raw);
    const res = await handleWebhookEvent(env, post(raw.replace('"uW"', '"attacker"'), sig));
    expect(res.status).toBe(401);
    expect(client.calls.privateReply).toHaveLength(0);
  });

  it("rejects signed-but-malformed JSON without reaching the engine", async () => {
    const env = await envFor("polling");
    const raw = '{"entry": [';
    const res = await handleWebhookEvent(env, post(raw, await sign(raw)));
    expect(res.status).toBe(400);
    expect(client.calls.privateReply).toHaveLength(0);
  });
});

describe("one bad event never blocks the rest of the batch", () => {
  it("two good comments still send when the first one throws", async () => {
    const env = await envFor("polling");
    const rt = runtime as { engine: Engine };
    const real = rt.engine.handleComment.bind(rt.engine);
    let n = 0;
    rt.engine.handleComment = async (e: never) => {
      if (n++ === 0) throw new Error("poisoned event");
      return real(e);
    };

    const batch = { entry: [{ changes: [
      { field: "comments", value: { id: "a", text: "LINK", timestamp: new Date(T * 1000).toISOString(), from: { id: "uA" }, media: { id: "m1" } } },
      { field: "comments", value: { id: "b", text: "LINK", timestamp: new Date(T * 1000).toISOString(), from: { id: "uB" }, media: { id: "m1" } } },
      { field: "comments", value: { id: "c", text: "LINK", timestamp: new Date(T * 1000).toISOString(), from: { id: "uC" }, media: { id: "m1" } } },
    ] }] };
    const raw = JSON.stringify(batch);
    const res = await handleWebhookEvent(env, post(raw, await sign(raw)));

    // 200, not 5xx: the events that succeeded are already delivered, and repeated 5xx is how Meta
    // decides an endpoint is unhealthy and stops delivering to it. The failed one is left for the
    // reconciliation poll underneath.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, failed: 1 });
    expect(client.calls.privateReply).toHaveLength(2);
  });
});

describe("subscription handshake", () => {
  it("echoes the challenge for the right verify token and refuses a wrong one", async () => {
    const env = { MODE: "polling", WEBHOOK_VERIFY_TOKEN: "vtok" } as unknown as Env;
    const ok = handleWebhookVerify(env, new URL("https://x/webhook?hub.mode=subscribe&hub.verify_token=vtok&hub.challenge=42"));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("42");
    const bad = handleWebhookVerify(env, new URL("https://x/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42"));
    expect(bad.status).toBe(403);
  });
});

describe("POST /admin/webhook reports what Meta actually stored", () => {
  async function adminEnv() {
    const db = makeTestDb();
    client = new FakeClient();
    runtime = { client, igUserId: "me" };
    return { DB: db, MODE: "polling", APP_SECRET } as unknown as Env;
  }

  it("confirms success by reading the subscription back, not by echoing its own input", async () => {
    const env = await adminEnv();
    const res = await handleWebhookAdmin(env, "POST");
    const body = await res.json() as Record<string, unknown>;
    expect(client.subscribeCalls).toBe(1);
    expect(body).toMatchObject({ ok: true, confirmed: true, subscribed_fields: ["comments", "messages"], missing: [] });
  });

  it("REGRESSION GUARD: a subscribe that silently persists only `messages` is reported, not celebrated", async () => {
    const env = await adminEnv();
    // Exactly the state this account was found in: taps push instantly, new comments do not.
    client.acceptFields = ["messages"];
    const res = await handleWebhookAdmin(env, "POST");
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(false);                       // the old version returned ok:true here
    expect(body.subscribed_fields).toEqual(["messages"]);
    expect(body.missing).toEqual(["comments"]);
    expect(String(body.note)).toContain("Meta app dashboard");
  });

  it("a failed read-back still says the subscribe succeeded, rather than implying nothing happened", async () => {
    const env = await adminEnv();
    client.failReadBack = true;
    const res = await handleWebhookAdmin(env, "POST");
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, confirmed: false });
    expect(client.subscribeCalls).toBe(1);
  });

  it("GET reports subscribed:false when the account has no subscription at all", async () => {
    const env = await adminEnv();
    const res = await handleWebhookAdmin(env, "GET");
    expect(await res.json()).toMatchObject({ subscribed: false, subscriptions: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The reported bug, end to end on the path production actually uses: someone comments, gets the
// opening DM, ignores the button, and types a message. They used to be handed the reward for it.
describe("a typed DM is not a button press (regression)", () => {
  const send = async (env: Env, body: unknown) => {
    const raw = JSON.stringify(body);
    return handleWebhookEvent(env, post(raw, await sign(raw)));
  };

  it("typing after the opening DM does not deliver the reward", async () => {
    const env = await envFor("polling");
    await send(env, commentPush());
    expect(client.calls.privateReply).toHaveLength(1); // opening DM went out

    const res = await send(env, typedPush("hey what is this?"));
    expect(res.status).toBe(200);
    expect(client.calls.text).toHaveLength(0); // ← the bug: this used to be 1
  });

  it("the button they ignored is put back in front of them, capped at twice", async () => {
    const env = await envFor("polling");
    await send(env, commentPush());

    await send(env, typedPush("hey"));
    await send(env, typedPush("hello?"));
    await send(env, typedPush("anyone there"));

    expect(client.calls.button).toHaveLength(2); // two nudges, then quiet — not one DM per message
    const nudge = client.calls.button[0] as { buttons: { payload: string }[] };
    expect(nudge.buttons[0]!.payload).toBe("OPENING_TAP:c1");
    expect(client.calls.text).toHaveLength(0); // and still no reward
  });

  it("an actual press still delivers, so the funnel is not simply broken", async () => {
    const env = await envFor("polling");
    await send(env, commentPush());
    await send(env, pressPush("OPENING_TAP:c1"));
    expect(client.calls.text).toHaveLength(1);
  });
});

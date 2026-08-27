// Inbound webhooks. NOTE: this route is NOT gated on MODE — if Meta is configured to push to
// /webhook, those events are verified and dispatched to the engine immediately, whatever MODE says.
//
// MODE governs the CRON only (see runtime.pollIntervalSeconds): "polling" polls at
// POLL_INTERVAL_SECONDS, "webhook" drops to the slower WEBHOOK_RECONCILE_SECONDS sweep.
//
// So MODE = "polling" WITH the Meta callback configured is a deliberate, and arguably the best,
// combination: push makes delivery instant, and a frequent poll stays underneath as a safety net
// for anything a webhook delivery drops. Running both is safe — the idempotency ledgers recognise
// an already-handled comment and skip it. Do not "fix" this by gating the route on MODE; that
// would silently turn instant delivery back into poll-speed delivery.
// GET verifies the subscription handshake; POST verifies the X-Hub-Signature-256 signature
// (mandatory) then normalizes comment/message events into the same transport-agnostic engine.

import { WEBHOOK_FIELDS } from "../api/client";
import { buildRuntime, toUnixSeconds } from "../runtime";
import type { Env, NormalizedComment, NormalizedMessage } from "../types";
import { json } from "./http";

/** GET /webhook — Meta subscription verification handshake. */
export function handleWebhookVerify(env: Env, url: URL): Response {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token && token === env.WEBHOOK_VERIFY_TOKEN && challenge) {
    return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
  }
  return new Response("forbidden", { status: 403 });
}

/**
 * GET|POST /admin/webhook — owner-only. GET reports whether this account is actually subscribed;
 * POST (re)subscribes it. Connecting already subscribes automatically, so this is the retry path
 * when that failed, and the way to confirm a silent webhook is a subscription problem rather than
 * a signature or routing one.
 */
export async function handleWebhookAdmin(env: Env, method: string): Promise<Response> {
  const rt = await buildRuntime(env);
  if (!rt) return json({ error: "no Instagram account connected" }, 400);
  try {
    if (method === "POST") {
      await rt.client.subscribeToWebhooks();

      // Read the subscription back rather than echoing what we just asked for. Reporting our own
      // input made this endpoint claim success whatever actually happened — which is worse than
      // useless here, because a partial subscription is silent by nature: subscribed to `messages`
      // but not `comments` means button taps arrive instantly while new comments fall back to the
      // poll, so the funnel still works and only feels inexplicably slow at the first step.
      let actual: string[] | null = null;
      try {
        actual = (await rt.client.getWebhookSubscriptions()).flatMap((s) => s.subscribed_fields ?? []);
      } catch (e) {
        // The subscribe itself succeeded; only the confirmation failed. Say exactly that rather
        // than failing the whole call and implying nothing happened.
        return json({
          ok: true,
          confirmed: false,
          requested: WEBHOOK_FIELDS,
          mode: env.MODE,
          note: `Subscribed, but reading the subscription back failed (${e instanceof Error ? e.message : e}). Re-check with GET /admin/webhook.`,
        });
      }

      const missing = WEBHOOK_FIELDS.split(",").filter((f) => !actual!.includes(f));
      return json({
        ok: missing.length === 0,
        confirmed: true,
        requested: WEBHOOK_FIELDS,
        subscribed_fields: actual,
        missing,
        mode: env.MODE,
        ...(missing.length > 0
          ? {
              note: `Still missing: ${missing.join(", ")}. The account is subscribed, so this is the APP-level config — open your Meta app dashboard, Webhooks -> Instagram, and tick ${missing.join(" and ")} there too. Account and app subscriptions are separate, and a field has to be in both.`,
            }
          : {}),
      });
    }
    const subs = await rt.client.getWebhookSubscriptions();
    return json({
      mode: env.MODE,
      subscribed: subs.length > 0,
      subscriptions: subs,
      verify_token_configured: Boolean(env.WEBHOOK_VERIFY_TOKEN),
      note:
        env.MODE === "webhook"
          ? "Events also require the callback URL configured in the Meta app dashboard."
          : `MODE is 'polling', which only affects the cron. Pushed events are still processed the moment they arrive, so a configured callback URL gives instant delivery with polling every ${env.POLL_INTERVAL_SECONDS ?? "?"}s underneath as a safety net.`,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
}

/** POST /webhook — verify signature, then dispatch normalized events to the engine. */
export async function handleWebhookEvent(env: Env, req: Request): Promise<Response> {
  const raw = await req.text();
  const sig = req.headers.get("x-hub-signature-256");
  if (!(await verifySignature(env.APP_SECRET, raw, sig))) {
    return new Response("invalid signature", { status: 401 });
  }

  let body: WebhookBody;
  try {
    body = JSON.parse(raw) as WebhookBody;
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const rt = await buildRuntime(env);
  if (!rt) return json({ ok: true, note: "no account connected" });

  // Every event in the batch is dispatched independently. One event that throws must never block
  // the others: this is the push path, and blocking it is exactly what turns a single bad event
  // into "nobody got their DM". A failed event is left for the reconciliation poll underneath to
  // pick up (the engine commits state only after a successful send, so nothing is half-applied),
  // which is what that poll is for. We still answer 200 so Meta does not re-push the events that
  // already succeeded — they are idempotent, but repeated 5xx marks the endpoint unhealthy and
  // Meta eventually stops delivering to it altogether.
  let failed = 0;
  const dispatch = async (label: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (e) {
      failed++;
      console.warn(`[chatmany] webhook ${label} failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  for (const entry of body.entry ?? []) {
    // Comment change events.
    for (const change of entry.changes ?? []) {
      if (change.field !== "comments") continue;
      const v = change.value;
      const igsid = v.from?.id;
      const mediaId = v.media?.id;
      if (!igsid || !mediaId || !v.id) continue;
      const evt: NormalizedComment = {
        kind: "comment",
        comment_id: v.id,
        igsid,
        username: v.from?.username,
        text: v.text ?? "",
        media_id: mediaId,
        timestamp: toUnixSeconds(v.timestamp),
      };
      await dispatch(`comment ${v.id}`, () => rt.engine.handleComment(evt));
    }

    // Messaging events (taps, replies, postbacks).
    //
    // `messaging` is NOT a list of messages. Instagram puts every conversation signal in it: read
    // receipts, reactions, delivery confirmations. Each of those carries the person's sender id and
    // NO message and NO postback, so normalizing one produced an event with no text and no payload
    // — indistinguishable from somebody typing, once a press had to prove itself with a payload.
    //
    // The result was a DM answering the fact that they OPENED the thread. Both reported threads
    // show it: a follow gate sent, then a second one three to four seconds later, which is the read
    // receipt landing as soon as the person looked at the first. Not a reply — an "I saw it".
    //
    // So only real inbound content is dispatched. An is_echo message is our own outbound coming
    // back and must never be treated as theirs either.
    for (const m of entry.messaging ?? []) {
      const igsid = m.sender?.id;
      if (!igsid || igsid === rt.igUserId) continue;
      if (m.message?.is_echo) continue;
      if (!m.message && !m.postback) continue; // read / reaction / delivery receipt
      const payload = m.postback?.payload ?? m.message?.quick_reply?.payload;
      const evt: NormalizedMessage = {
        kind: "message",
        igsid,
        text: m.message?.text ?? m.postback?.title,
        payload,
        timestamp: m.timestamp ? Math.floor(m.timestamp / 1000) : toUnixSeconds(undefined),
      };
      await dispatch(`message from ${igsid}`, () => rt.engine.handleMessage(evt));
    }
  }

  return failed > 0 ? json({ ok: true, failed }) : json({ ok: true });
}

async function verifySignature(appSecret: string, raw: string, header: string | null): Promise<boolean> {
  if (!header || !header.startsWith("sha256=") || !appSecret) return false;
  const expected = header.slice("sha256=".length);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const actual = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (actual.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < actual.length; i++) mismatch |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return mismatch === 0;
}

// ---- webhook payload shapes (subset we consume) ----

interface WebhookBody {
  entry?: WebhookEntry[];
}
interface WebhookEntry {
  changes?: Array<{ field: string; value: CommentValue }>;
  messaging?: MessagingEvent[];
}
interface CommentValue {
  id?: string;
  text?: string;
  timestamp?: string;
  from?: { id?: string; username?: string };
  media?: { id?: string };
}
interface MessagingEvent {
  sender?: { id?: string };
  timestamp?: number;
  message?: { text?: string; is_echo?: boolean; quick_reply?: { payload?: string } };
  postback?: { payload?: string; title?: string };
  // Present on the signals that are NOT inbound content. Declared so the shape documents why the
  // loop above filters on `message`/`postback` rather than trusting every entry to be a message.
  read?: unknown;
  reaction?: unknown;
  delivery?: unknown;
}

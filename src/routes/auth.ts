// OAuth onboarding routes (Section 4A). "Connect Instagram" → authorize redirect → callback
// code exchange → long-lived token stored in auth. Plus connection status + disconnect.

import { buildAuthorizeUrl, exchangeCodeForShortLivedToken, exchangeForLongLivedToken } from "../auth/oauth";
import { InstagramClient, WEBHOOK_FIELDS } from "../api/client";
import { clearAuth, getAuth, kvGet, kvSet, now, saveAuth } from "../db";
import { getPollAgeSeconds, getPollError } from "../poller/messagePoll";
import type { Env } from "../types";
import { json, redirect, html } from "./http";

const STATE_KEY = "oauth_state";

function randomState(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** GET /auth/authorize — start the OAuth flow. */
export async function handleAuthorize(env: Env): Promise<Response> {
  if (!env.APP_ID || !env.APP_SECRET) {
    return json({ error: "APP_ID/APP_SECRET not configured" }, 500);
  }
  const state = randomState();
  await kvSet(env.DB, STATE_KEY, state);
  return redirect(buildAuthorizeUrl(env.APP_ID, env.REDIRECT_URI, state));
}

/** GET /auth/callback — exchange the code, verify the account is professional, store the token. */
export async function handleCallback(env: Env, url: URL): Promise<Response> {
  const error = url.searchParams.get("error");
  if (error) {
    return html(`<h1>Connection cancelled</h1><p>${escapeHtml(error)}</p>`, 400);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) return html("<h1>Missing authorization code</h1>", 400);

  const expected = await kvGet(env.DB, STATE_KEY);
  if (!expected || state !== expected) return html("<h1>Invalid state (possible CSRF)</h1>", 400);

  try {
    const short = await exchangeCodeForShortLivedToken(env.APP_ID, env.APP_SECRET, env.REDIRECT_URI, code);
    // Diagnostic: Meta can silently grant fewer scopes than requested (e.g. a permission not yet
    // enabled for this app in the dashboard). Log what was actually granted vs. requested so a
    // "why can't I read comments" report can be root-caused without guessing.
    console.log(`[chatmany] OAuth granted permissions: ${JSON.stringify(short.permissions ?? "none reported")}`);
    const long = await exchangeForLongLivedToken(env.GRAPH_VERSION, env.APP_SECRET, short.accessToken);

    // Fetch the profile to enforce the professional-account requirement + power the UI preview.
    const client = new InstagramClient(long.accessToken, env.GRAPH_VERSION, "me");
    const me = await client.getMe();
    const accountType = (me.account_type ?? "").toUpperCase();
    if (accountType === "PERSONAL") {
      return html(
        `<h1>Personal accounts aren't supported</h1>
         <p>chatmany needs an Instagram <b>Professional</b> (Creator or Business) account.</p>
         <p>In the Instagram app: <b>Settings → Account type and tools → Switch to professional account</b>, then reconnect.</p>`,
        400,
      );
    }

    // Takeover guard. /auth/callback is necessarily public (Instagram calls it), and auth is a
    // single global row, so without this check anyone who completes the flow would silently
    // replace the owner's stored token with their own account. Connecting a different account
    // requires an explicit Disconnect from the dashboard first.
    const incomingUserId = me.user_id ?? short.userId;
    const existing = await getAuth(env.DB);
    if (existing && existing.ig_user_id && existing.ig_user_id !== incomingUserId) {
      return html(
        `<h1>Already connected</h1>
         <p>This chatmany instance is already connected to <b>@${escapeHtml(existing.username ?? existing.ig_user_id)}</b>.</p>
         <p>To connect a different account, open your dashboard and click <b>Disconnect</b> first.</p>`,
        409,
      );
    }

    await saveAuth(env.DB, {
      access_token: long.accessToken,
      expires_at: now() + long.expiresIn,
      ig_user_id: incomingUserId,
      username: me.username ?? null,
      account_type: me.account_type ?? null,
      profile_picture_url: me.profile_picture_url ?? null,
    });

    // Subscribe the account to the app's webhooks — ALWAYS, not only when MODE is "webhook".
    //
    // Pushed events are processed whatever MODE says (see routes/webhook.ts); MODE governs only the
    // cron cadence. So "polling" plus a configured callback URL is a real and desirable setup —
    // instant delivery, with a frequent poll underneath as a safety net — and this instance runs
    // exactly that. Gating the subscribe on MODE meant such a setup lost its subscription the next
    // time the owner reconnected Instagram, after a token expiry or a disconnect/reconnect. Push
    // would then stop dead, delivery would quietly drop back to poll speed, and nothing would say
    // why: no error, no log, just slower.
    //
    // Subscribing when no callback URL is registered costs one API call and delivers nothing, so
    // doing it unconditionally is safe. Non-fatal — the connection itself already succeeded, and
    // /admin/webhook can retry and report.
    let webhookNote = "";
    {
      try {
        const client2 = new InstagramClient(long.accessToken, env.GRAPH_VERSION, incomingUserId);
        await client2.subscribeToWebhooks();
        webhookNote = `<p>Subscribed this account to <code>${escapeHtml(WEBHOOK_FIELDS)}</code> webhooks. Events arrive instantly once the callback URL is set in your Meta app; polling keeps running underneath either way.</p>`;
      } catch (e) {
        const detail = escapeHtml(e instanceof Error ? e.message : String(e));
        console.warn(`[chatmany] webhook subscribe failed: ${detail}`);
        webhookNote =
          `<p>⚠️ Connected, but subscribing this account to webhooks failed:</p><pre>${detail}</pre>` +
          `<p>Polling still works. To get instant delivery, retry with <code>POST /admin/webhook</code> using your owner token.</p>`;
      }
    }

    return html(
      `<h1>Connected ✅</h1>
       <p>@${escapeHtml(me.username ?? "your account")} is now connected to chatmany.</p>
       <p>Token valid ~60 days; it auto-refreshes. You can close this tab.</p>
       ${webhookNote}`,
    );
  } catch (e) {
    return html(`<h1>Connection failed</h1><pre>${escapeHtml(e instanceof Error ? e.message : String(e))}</pre>`, 500);
  }
}

/** GET /auth/status — connection status (owner-only). */
export async function handleStatus(env: Env): Promise<Response> {
  const auth = await getAuth(env.DB);
  if (!auth) return json({ connected: false });
  // Poll health. A stalled poller used to be completely invisible from the outside: the dashboard
  // looked fine while no message had been processed for hours. poll_age_seconds is the tell —
  // a healthy message poll refreshes its cursor every tick, so anything beyond a few minutes
  // means the poller is not completing.
  const pollAge = await getPollAgeSeconds(env.DB);
  const pollError = await getPollError(env.DB);
  return json({
    connected: true,
    username: auth.username,
    account_type: auth.account_type,
    profile_picture_url: auth.profile_picture_url,
    ig_user_id: auth.ig_user_id,
    expires_at: auth.expires_at,
    expires_in_days: Math.max(0, Math.round((auth.expires_at - now()) / 86400)),
    poll_age_seconds: pollAge,
    poll_healthy: pollAge !== null && pollAge < 600,
    poll_error: pollError,
  });
}

/** POST /auth/disconnect — clear the token (owner-only). */
export async function handleDisconnect(env: Env): Promise<Response> {
  await clearAuth(env.DB);
  return json({ disconnected: true });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

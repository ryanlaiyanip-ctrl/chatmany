// OAuth onboarding routes (Section 4A). "Connect Instagram" → authorize redirect → callback
// code exchange → long-lived token stored in auth. Plus connection status + disconnect.

import { buildAuthorizeUrl, exchangeCodeForShortLivedToken, exchangeForLongLivedToken } from "../auth/oauth";
import { InstagramClient } from "../api/client";
import { clearAuth, getAuth, kvGet, kvSet, now, saveAuth } from "../db";
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

    return html(
      `<h1>Connected ✅</h1>
       <p>@${escapeHtml(me.username ?? "your account")} is now connected to chatmany.</p>
       <p>Token valid ~60 days; it auto-refreshes. You can close this tab.</p>`,
    );
  } catch (e) {
    return html(`<h1>Connection failed</h1><pre>${escapeHtml(e instanceof Error ? e.message : String(e))}</pre>`, 500);
  }
}

/** GET /auth/status — connection status (owner-only). */
export async function handleStatus(env: Env): Promise<Response> {
  const auth = await getAuth(env.DB);
  if (!auth) return json({ connected: false });
  return json({
    connected: true,
    username: auth.username,
    account_type: auth.account_type,
    profile_picture_url: auth.profile_picture_url,
    ig_user_id: auth.ig_user_id,
    expires_at: auth.expires_at,
    expires_in_days: Math.max(0, Math.round((auth.expires_at - now()) / 86400)),
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

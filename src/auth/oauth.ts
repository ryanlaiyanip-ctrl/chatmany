// OAuth 2.0 Business Login for "Instagram API with Instagram Login" (Section 4A).
// The self-hoster registers the app once (APP_ID/APP_SECRET/REDIRECT_URI). The in-app
// "Connect Instagram" button sends the owner to Instagram's authorize page; the callback
// exchanges the returned code for a short-lived token, then a long-lived (~60 day) token.
//
// chatmany never sees the user's Instagram password — approval happens on Instagram's page.

import { InstagramApiError } from "../api/client";

export const SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
];

/** Build the Instagram authorize URL to redirect the owner to. `state` is a CSRF token. */
export function buildAuthorizeUrl(appId: string, redirectUri: string, state: string): string {
  const url = new URL("https://www.instagram.com/oauth/authorize");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(","));
  url.searchParams.set("state", state);
  return url.toString();
}

interface ShortLivedTokenResponse {
  access_token: string;
  user_id: number | string;
  permissions?: string[];
}

/** Exchange the authorization code for a short-lived token (server-side, uses APP_SECRET). */
export async function exchangeCodeForShortLivedToken(
  appId: string,
  appSecret: string,
  redirectUri: string,
  code: string,
): Promise<{ accessToken: string; userId: string; permissions?: string[] }> {
  const body = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code,
  });
  const res = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new InstagramApiError(`code exchange failed: ${text}`, res.status);
  const json = JSON.parse(text) as ShortLivedTokenResponse;
  return { accessToken: json.access_token, userId: String(json.user_id), permissions: json.permissions };
}

interface LongLivedTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number; // seconds (~60 days)
}

/** Exchange a short-lived token for a long-lived (~60 day) token. The endpoint is unversioned
 * (no /vXX.X/ prefix — verified live Aug 2026). NOTE: if every Graph call, including this one,
 * fails with "Unsupported request - method type: get" (code 100), the real cause is a missing
 * Instagram Tester role — the account must be added under App roles AND accept the invite at
 * instagram.com → Settings → Apps and websites → Tester invites (README step 1.7). */
export async function exchangeForLongLivedToken(
  version: string,
  appSecret: string,
  shortLivedToken: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const url = new URL("https://graph.instagram.com/access_token");
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("access_token", shortLivedToken);
  const res = await fetch(url.toString());
  const text = await res.text();
  if (!res.ok) throw new InstagramApiError(`long-lived exchange failed: ${text}`, res.status);
  const json = JSON.parse(text) as LongLivedTokenResponse;
  return { accessToken: json.access_token, expiresIn: json.expires_in };
}

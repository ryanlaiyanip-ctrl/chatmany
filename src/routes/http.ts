// Small HTTP response helpers + owner-token auth guard.

import type { Env } from "../types";

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function html(body: string, status = 200): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:40rem;margin:3rem auto;padding:0 1rem">${body}</body>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export function redirect(location: string, status = 302): Response {
  // no-referrer: /auth/authorize is reached with `?token=<OWNER_TOKEN>` in the query (a plain
  // link navigation cannot set an Authorization header), so make sure that URL is never handed
  // to instagram.com in a Referer header.
  return new Response(null, { status, headers: { location, "referrer-policy": "no-referrer" } });
}

/**
 * Owner auth: the single-owner token in `Authorization: Bearer <OWNER_TOKEN>` or `?token=`.
 * Returns true when authorized. Uses a constant-time compare.
 */
export function isOwner(req: Request, url: URL, env: Env): boolean {
  if (!env.OWNER_TOKEN) return false;
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const supplied = bearer || url.searchParams.get("token") || "";
  return timingSafeEqual(supplied, env.OWNER_TOKEN);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

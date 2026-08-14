// chatmany Worker entry point. `fetch` serves the OAuth onboarding + owner API routes;
// `scheduled` runs the polling crons and the daily token refresh. The UI (Section 7A) will be
// added later and served from this same Worker.

import type { Env } from "./types";
import { buildRuntime } from "./runtime";
import { pollComments } from "./poller/commentPoll";
import { pollMessages } from "./poller/messagePoll";
import { refreshTokenIfDue } from "./auth/refresh";
import { claimPollSlot } from "./db";
import { handleAuthorize, handleCallback, handleDisconnect, handleStatus } from "./routes/auth";
import { handleConfigExport, handleConfigImport } from "./routes/config";
import { handleWebhookEvent, handleWebhookVerify } from "./routes/webhook";
import { handleApi } from "./routes/api";
import { isOwner, json } from "./routes/http";

const POLL_CRON = "* * * * *";
const REFRESH_CRON = "0 3 * * *";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method.toUpperCase();

    // --- public routes ---
    if (pathname === "/health") return json({ ok: true, mode: env.MODE });

    // OAuth onboarding. /auth/callback must stay public — Instagram itself calls it, with no
    // owner token — so the takeover guard lives in handleCallback (it refuses to overwrite an
    // existing connection with a different account). /auth/authorize is owner-only, below.
    if (pathname === "/auth/callback" && method === "GET") return handleCallback(env, url);

    // Webhook (only meaningful when MODE=webhook; verification is always safe to answer).
    if (pathname === "/webhook" && method === "GET") return handleWebhookVerify(env, url);
    if (pathname === "/webhook" && method === "POST") return handleWebhookEvent(env, req);

    // --- owner-only API + admin routes ---
    if (pathname.startsWith("/api/")) {
      if (!isOwner(req, url, env)) return json({ error: "unauthorized" }, 401);
      return handleApi(env, req, url);
    }
    const ownerRoutes = new Set([
      "/auth/authorize",
      "/auth/status",
      "/auth/disconnect",
      "/config/import",
      "/config/export",
      "/admin/poll",
    ]);
    if (ownerRoutes.has(pathname)) {
      if (!isOwner(req, url, env)) return json({ error: "unauthorized" }, 401);
      if (pathname === "/auth/authorize" && method === "GET") return handleAuthorize(env);
      if (pathname === "/auth/status" && method === "GET") return handleStatus(env);
      if (pathname === "/auth/disconnect" && method === "POST") return handleDisconnect(env);
      if (pathname === "/config/import" && method === "POST") return handleConfigImport(env, req);
      if (pathname === "/config/export" && method === "GET") return handleConfigExport(env);
      // Manual poll trigger for testing without waiting for cron.
      if (pathname === "/admin/poll" && method === "POST") {
        await runPoll(env);
        return json({ ok: true, ran: "poll" });
      }
      return json({ error: "method not allowed" }, 405);
    }

    // --- web UI (static assets + SPA fallback) ---
    // Matched static files are served by the assets binding automatically; this handles
    // client-side routes by returning index.html for navigations.
    const assetRes = await env.ASSETS.fetch(req);
    if (assetRes.status !== 404) return assetRes;
    if (method === "GET") {
      return env.ASSETS.fetch(new Request(new URL("/index.html", url.origin), req));
    }
    return json({ error: "not found" }, 404);
  },

  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    if (event.cron === REFRESH_CRON) {
      const result = await refreshTokenIfDue(env);
      console.log(`[chatmany] token refresh: ${result.status}`);
      return;
    }
    if (event.cron === POLL_CRON) {
      // In webhook mode, push replaces polling; skip the comment/message polls.
      if (env.MODE === "webhook") return;
      await runPoll(env);
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * Run comment + message polls, honoring the configured poll interval (>= cron granularity).
 * claimPollSlot is an atomic claim, not a plain check-then-act read/write — see its doc comment
 * in db.ts for why that distinction matters: it's what stops an overlapping cron tick or a
 * /admin/poll call racing the cron from both polling at once and double-sending a real DM.
 */
async function runPoll(env: Env): Promise<void> {
  const interval = Math.max(30, Number(env.POLL_INTERVAL_SECONDS) || 90);
  const claimed = await claimPollSlot(env.DB, interval);
  if (!claimed) return; // not due yet, or another invocation already claimed this slot

  const rt = await buildRuntime(env);
  if (!rt) return;

  await pollComments(rt, env.DB);
  await pollMessages(rt, env.DB);
}

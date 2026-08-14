// D1 data-access helpers. All timestamps are unix seconds. Kept intentionally thin so the
// engine stays readable and cron ticks do minimal work (Workers free-tier 10ms CPU budget).

import type { AuthRow, Campaign, EventType, State } from "./types";
import { validateCampaign } from "./config";

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

// ---- campaigns ----

export interface StoredCampaign {
  campaign: Campaign;
  active: boolean;
}

/** Active campaigns only (Section 10: poll only active campaigns to conserve rate budget). An
 * archived campaign is never polled even if its `active` flag is still on. */
export async function getActiveCampaigns(db: D1Database): Promise<Campaign[]> {
  const rows = await db
    .prepare("SELECT config_json FROM campaigns WHERE active = 1 AND archived_at IS NULL")
    .all<{ config_json: string }>();
  const out: Campaign[] = [];
  for (const r of rows.results ?? []) {
    try {
      out.push(validateCampaign(JSON.parse(r.config_json)));
    } catch {
      // Skip malformed rows rather than aborting the whole poll.
    }
  }
  return out;
}

export async function getCampaign(db: D1Database, campaignId: string): Promise<Campaign | null> {
  const row = await db
    .prepare("SELECT config_json FROM campaigns WHERE campaign_id = ?")
    .bind(campaignId)
    .first<{ config_json: string }>();
  if (!row) return null;
  try {
    return validateCampaign(JSON.parse(row.config_json));
  } catch {
    return null;
  }
}

export interface CampaignListItem {
  campaign: Campaign;
  active: boolean;
  archived: boolean;
  updated_at: number;
}

/**
 * Campaigns for the builder list. By default returns only non-archived ones (active + stopped),
 * matching the main Automations tab; pass `{ archived: true }` for the Archive tab's contents.
 * Malformed rows are skipped.
 */
export async function getAllCampaigns(db: D1Database, opts: { archived?: boolean } = {}): Promise<CampaignListItem[]> {
  const where = opts.archived ? "archived_at IS NOT NULL" : "archived_at IS NULL";
  const rows = await db
    .prepare(`SELECT config_json, active, updated_at, archived_at FROM campaigns WHERE ${where} ORDER BY updated_at DESC`)
    .all<{ config_json: string; active: number; updated_at: number; archived_at: number | null }>();
  const out: CampaignListItem[] = [];
  for (const r of rows.results ?? []) {
    try {
      out.push({
        campaign: validateCampaign(JSON.parse(r.config_json)),
        active: r.active === 1,
        archived: r.archived_at != null,
        updated_at: r.updated_at,
      });
    } catch {
      // skip malformed
    }
  }
  return out;
}

export async function setCampaignActive(db: D1Database, campaignId: string, active: boolean): Promise<void> {
  await db
    .prepare("UPDATE campaigns SET active = ?, updated_at = ? WHERE campaign_id = ?")
    .bind(active ? 1 : 0, now(), campaignId)
    .run();
}

/** Archive (soft-delete) or restore a campaign. Archiving keeps all its history intact — unlike
 * deleteCampaign, which is permanent — but stops it from being polled (see getActiveCampaigns). */
export async function setCampaignArchived(db: D1Database, campaignId: string, archived: boolean): Promise<void> {
  await db
    .prepare("UPDATE campaigns SET archived_at = ?, updated_at = ? WHERE campaign_id = ?")
    .bind(archived ? now() : null, now(), campaignId)
    .run();
}

/**
 * Delete a campaign and everything tied to it — conversations (the dedup ledger), the
 * processed-comments idempotency log, and its events. Without this, a deleted campaign's history
 * stays orphaned in D1; if a later campaign is ever created with the same campaign_id (e.g. the
 * builder UI slugifying the same name again), it silently inherits that old history — including
 * "already messaged this person" dedup rows — and behaves like the deleted campaign never left.
 */
export async function deleteCampaign(db: D1Database, campaignId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM campaigns WHERE campaign_id = ?").bind(campaignId),
    db.prepare("DELETE FROM conversations WHERE campaign_id = ?").bind(campaignId),
    db.prepare("DELETE FROM processed_comments WHERE campaign_id = ?").bind(campaignId),
    db.prepare("DELETE FROM events WHERE campaign_id = ?").bind(campaignId),
  ]);
}

export async function upsertCampaign(db: D1Database, campaign: Campaign, active = true): Promise<void> {
  await db
    .prepare(
      `INSERT INTO campaigns (campaign_id, platform, media_id, config_json, active, updated_at)
       VALUES (?, 'instagram', ?, ?, ?, ?)
       ON CONFLICT(campaign_id) DO UPDATE SET
         media_id = excluded.media_id,
         config_json = excluded.config_json,
         active = excluded.active,
         updated_at = excluded.updated_at`,
    )
    .bind(campaign.campaign_id, campaign.media_id, JSON.stringify(campaign), active ? 1 : 0, now())
    .run();
}

// ---- idempotency ledgers ----

export async function isCommentProcessed(db: D1Database, commentId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM processed_comments WHERE comment_id = ?")
    .bind(commentId)
    .first();
  return row !== null;
}

export async function markCommentProcessed(
  db: D1Database,
  commentId: string,
  igsid: string,
  campaignId: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO processed_comments (comment_id, igsid, campaign_id, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(commentId, igsid, campaignId, now())
    .run();
}

/** Returns true if this (comment, action) pair had not been recorded before (i.e. we may act now). */
/**
 * Claim an outbound send before it is attempted. Returns true if this caller owns the send
 * (newly claimed), false if a previous attempt already claimed it — in which case that earlier
 * attempt may have delivered, and re-sending would show the recipient the same DM twice.
 */
export async function claimSend(db: D1Database, key: string): Promise<boolean> {
  const res = await db
    .prepare(`INSERT OR IGNORE INTO send_claims (key, created_at) VALUES (?, ?)`)
    .bind(key, now())
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Release a claim so the send can be retried. Only safe when the platform definitively rejected
 * the request (nothing was delivered) — never after an ambiguous failure.
 */
export async function releaseSend(db: D1Database, key: string): Promise<void> {
  await db.prepare(`DELETE FROM send_claims WHERE key = ?`).bind(key).run();
}

export async function claimCommentAction(
  db: D1Database,
  commentId: string,
  action: "public_reply" | "like",
): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO comment_actions (comment_id, action, created_at) VALUES (?, ?, ?)`,
    )
    .bind(commentId, action, now())
    .run();
  // meta.changes === 1 means the row was newly inserted (not a duplicate).
  return (res.meta.changes ?? 0) > 0;
}

// ---- conversations ----

export interface ConversationRow {
  igsid: string;
  campaign_id: string;
  state: State;
  username: string | null;
  email: string | null;
  followed: number;
  /** @deprecated Counter for the removed verify_follow_count mode; nothing writes it. */
  follow_retries: number;
  /** How many times we have re-asked for their email. Capped — see engine.resendEmailAsk. */
  email_retries: number;
  updated_at: number;
  created_at: number;
}

export async function getConversation(
  db: D1Database,
  igsid: string,
  campaignId: string,
): Promise<ConversationRow | null> {
  return await db
    .prepare("SELECT * FROM conversations WHERE igsid = ? AND campaign_id = ?")
    .bind(igsid, campaignId)
    .first<ConversationRow>();
}

/** All non-terminal conversations for a person (a message may advance any of them). */
export async function getOpenConversations(
  db: D1Database,
  igsid: string,
): Promise<ConversationRow[]> {
  const rows = await db
    .prepare("SELECT * FROM conversations WHERE igsid = ? AND state != 'DONE'")
    .bind(igsid)
    .all<ConversationRow>();
  return rows.results ?? [];
}

export async function createConversation(
  db: D1Database,
  igsid: string,
  campaignId: string,
  username: string | null,
  state: State,
): Promise<void> {
  const ts = now();
  await db
    .prepare(
      `INSERT OR IGNORE INTO conversations
         (igsid, campaign_id, state, username, followed, follow_retries, email_retries, updated_at, created_at)
       VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?)`,
    )
    .bind(igsid, campaignId, state, username, ts, ts)
    .run();
}

export async function updateConversation(
  db: D1Database,
  igsid: string,
  campaignId: string,
  patch: Partial<Pick<ConversationRow, "state" | "email" | "followed" | "email_retries">>,
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.state !== undefined) {
    sets.push("state = ?");
    binds.push(patch.state);
  }
  if (patch.email !== undefined) {
    sets.push("email = ?");
    binds.push(patch.email);
  }
  if (patch.followed !== undefined) {
    sets.push("followed = ?");
    binds.push(patch.followed);
  }
  if (patch.email_retries !== undefined) {
    sets.push("email_retries = ?");
    binds.push(patch.email_retries);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  binds.push(now(), igsid, campaignId);
  await db
    .prepare(`UPDATE conversations SET ${sets.join(", ")} WHERE igsid = ? AND campaign_id = ?`)
    .bind(...binds)
    .run();
}

// ---- events ----

export async function logEvent(
  db: D1Database,
  campaignId: string,
  type: EventType,
  igsid: string | null,
): Promise<void> {
  await db
    .prepare(`INSERT INTO events (campaign_id, igsid, type, created_at) VALUES (?, ?, ?, ?)`)
    .bind(campaignId, igsid, type, now())
    .run();
}

/** Count events of a type for a campaign since a unix-second cutoff (rate-cap + dashboard). */
export async function countEvents(
  db: D1Database,
  campaignId: string,
  type: EventType,
  sinceTs: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM events WHERE campaign_id = ? AND type = ? AND created_at >= ?`,
    )
    .bind(campaignId, type, sinceTs)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Account-wide count of an event type since a cutoff (used for the global send rate cap). */
export async function countEventsGlobal(
  db: D1Database,
  type: EventType,
  sinceTs: number,
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE type = ? AND created_at >= ?`)
    .bind(type, sinceTs)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Grouped event counts by type (dashboard). Optionally scoped to one campaign. */
export async function eventCountsByType(
  db: D1Database,
  campaignId: string | null,
  sinceTs: number,
): Promise<Record<EventType, number>> {
  const base: Record<EventType, number> = {
    comment_matched: 0,
    opening_sent: 0,
    button_clicked: 0,
    follow_confirmed: 0,
    email_captured: 0,
    delivered: 0,
  };
  const rows = campaignId
    ? await db
        .prepare(
          `SELECT type, COUNT(*) AS n FROM events WHERE campaign_id = ? AND created_at >= ? GROUP BY type`,
        )
        .bind(campaignId, sinceTs)
        .all<{ type: EventType; n: number }>()
    : await db
        .prepare(`SELECT type, COUNT(*) AS n FROM events WHERE created_at >= ? GROUP BY type`)
        .bind(sinceTs)
        .all<{ type: EventType; n: number }>();
  for (const r of rows.results ?? []) {
    if (r.type in base) base[r.type] = r.n;
  }
  return base;
}

// ---- contacts ----

/** People who entered any campaign (Contacts page). Optionally scoped to one campaign. */
export async function listConversations(
  db: D1Database,
  campaignId: string | null,
  limit = 500,
): Promise<ConversationRow[]> {
  const rows = campaignId
    ? await db
        .prepare("SELECT * FROM conversations WHERE campaign_id = ? ORDER BY updated_at DESC LIMIT ?")
        .bind(campaignId, limit)
        .all<ConversationRow>()
    : await db
        .prepare("SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?")
        .bind(limit)
        .all<ConversationRow>();
  return rows.results ?? [];
}

// ---- auth ----

export async function getAuth(db: D1Database): Promise<AuthRow | null> {
  return await db.prepare("SELECT * FROM auth WHERE id = 1").first<AuthRow>();
}

export async function saveAuth(
  db: D1Database,
  fields: {
    access_token: string;
    expires_at: number;
    ig_user_id?: string | null;
    username?: string | null;
    account_type?: string | null;
    profile_picture_url?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO auth (id, access_token, ig_user_id, username, account_type, profile_picture_url, expires_at, refreshed_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         access_token = excluded.access_token,
         ig_user_id = COALESCE(excluded.ig_user_id, auth.ig_user_id),
         username = COALESCE(excluded.username, auth.username),
         account_type = COALESCE(excluded.account_type, auth.account_type),
         profile_picture_url = COALESCE(excluded.profile_picture_url, auth.profile_picture_url),
         expires_at = excluded.expires_at,
         refreshed_at = excluded.refreshed_at`,
    )
    .bind(
      fields.access_token,
      fields.ig_user_id ?? null,
      fields.username ?? null,
      fields.account_type ?? null,
      fields.profile_picture_url ?? null,
      fields.expires_at,
      now(),
    )
    .run();
}

export async function clearAuth(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM auth WHERE id = 1").run();
}

// ---- kv (small runtime state) ----

export async function kvGet(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM kv WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function kvSet(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, now())
    .run();
}

/**
 * Atomically claim the poll slot: returns true only if no other invocation has claimed it within
 * the last `intervalSeconds` — false if it's not due yet, or another invocation (an overlapping
 * cron tick, or /admin/poll racing the cron) already claimed it. This replaces a check-then-act
 * read-then-write that let two overlapping invocations both pass the "is it due" check before
 * either wrote the new timestamp; that gap let both actually poll and both send a real duplicate
 * DM for the same comment before either invocation's INSERT OR IGNORE dedup could kick in — D1's
 * idempotency ledgers stop a crash, but not a send that already happened.
 */
export async function claimPollSlot(db: D1Database, intervalSeconds: number): Promise<boolean> {
  const ts = now();
  // Seed the row on first-ever run so the UPDATE below has something to match against.
  await db
    .prepare(`INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES ('last_poll_ts', '0', ?)`)
    .bind(ts)
    .run();
  const res = await db
    .prepare(`UPDATE kv SET value = ?, updated_at = ? WHERE key = 'last_poll_ts' AND CAST(value AS INTEGER) <= ?`)
    .bind(String(ts), ts, ts - intervalSeconds)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

// Shared types for chatmany.

/** Cloudflare bindings + vars available on the Worker environment. */
export interface Env {
  DB: D1Database;
  /** Static-asset binding serving the web UI from ./public. */
  ASSETS: Fetcher;

  // vars (wrangler.toml [vars])
  GRAPH_VERSION: string;
  MODE: "polling" | "webhook";
  POLL_INTERVAL_SECONDS: string;
  REDIRECT_URI: string;

  // secrets (wrangler secret put ...)
  APP_ID: string;
  APP_SECRET: string;
  OWNER_TOKEN: string;
  WEBHOOK_VERIFY_TOKEN?: string;
}

/** Funnel state for one person in one campaign. */
export type State =
  | "NEW"
  | "AWAITING_TAP"
  | "AWAITING_FOLLOW"
  | "AWAITING_EMAIL"
  | "DELIVER"
  | "DONE";

/** Analytics event types (mirrors events.type). */
export type EventType =
  | "comment_matched"
  | "opening_sent"
  | "button_clicked"
  | "follow_confirmed"
  | "email_captured"
  | "delivered";

export interface RewardConfig {
  type: "link" | "code" | "text";
  value: string;
}

export interface PublicReplyConfig {
  enabled: boolean;
  texts: string[];
}

export interface CampaignCopy {
  opening: string;
  opening_button?: string;
  follow_gate?: string;
  follow_button?: string;
  email_ask?: string;
  delivery: string;
}

/** A single campaign (Section 7). Validated on load. */
export interface Campaign {
  campaign_id: string;
  /** Human-friendly automation name shown in the builder/list (optional). */
  name?: string;
  media_id: string;
  keywords: string[];
  exclude?: string[];
  public_reply?: PublicReplyConfig;
  /** @deprecated Instagram's API cannot like comments. Accepted for backwards compatibility; ignored. */
  like_comment?: boolean;
  check_follow?: boolean;
  /** @deprecated No API can verify a follow; the follower-count heuristic this drove was noise.
   *  Accepted for backwards compatibility so older saved campaigns keep loading; ignored. */
  verify_follow_count?: boolean;
  ask_email?: boolean;
  reward: RewardConfig;
  copy: CampaignCopy;
}

/** Top-level config file / import payload (Section 7). */
export interface AppConfig {
  mode?: "polling" | "webhook";
  poll_interval_seconds?: number;
  campaigns: Campaign[];
}

/** Normalized event the engine consumes, regardless of transport (poll or webhook). */
export interface NormalizedComment {
  kind: "comment";
  comment_id: string;
  igsid: string;
  username?: string;
  text: string;
  media_id: string;
  timestamp: number;
}

export interface NormalizedMessage {
  kind: "message";
  igsid: string;
  text?: string;
  /** Postback / quick-reply payload if the transport exposes it (webhooks do; polling may not). */
  payload?: string;
  /** Email captured from a user_email quick-reply chip, if present. */
  email?: string;
  timestamp: number;
}

export type NormalizedEvent = NormalizedComment | NormalizedMessage;

/** Stored auth row. */
export interface AuthRow {
  access_token: string;
  ig_user_id: string | null;
  username: string | null;
  account_type: string | null;
  profile_picture_url: string | null;
  expires_at: number;
  refreshed_at: number | null;
}

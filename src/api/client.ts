// Thin, typed wrappers over the official Instagram API with Instagram Login
// (host: graph.instagram.com). No scraping, no unofficial endpoints. All calls are
// documented Graph API operations. Build only from Meta docs; verify endpoint paths
// against the API version pinned in wrangler.toml (GRAPH_VERSION).

const GRAPH_HOST = "https://graph.instagram.com";

/** Webhook fields chatmany consumes. `comments` drives the funnel entry; `messages` carries taps,
 *  postback payloads, and typed replies. Both are needed — subscribing to only one silently breaks
 *  half the funnel. */
export const WEBHOOK_FIELDS = "comments,messages";

/** Meta error codes that indicate rate limiting / throttling (Section 10). */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80007]);

export class InstagramApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly subcode?: number,
    readonly fbtraceId?: string,
  ) {
    super(message);
    this.name = "InstagramApiError";
  }

  /** True when the platform is telling us to back off. */
  get isRateLimit(): boolean {
    return this.status === 429 || (this.code !== undefined && RATE_LIMIT_CODES.has(this.code));
  }
}

// ---- message payload shapes ----

export interface Button {
  type: "postback" | "web_url";
  title: string;
  payload?: string;
  url?: string;
}

export interface QuickReply {
  content_type: "text" | "user_email";
  title?: string;
  payload?: string;
}

export interface IgComment {
  id: string;
  text: string;
  timestamp?: string;
  username?: string;
  from?: { id: string; username?: string };
}

export interface IgMedia {
  id: string;
  caption?: string;
  media_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  like_count?: number;
  comments_count?: number;
}

export interface IgProfile {
  user_id: string;
  username: string;
  account_type?: string;
  profile_picture_url?: string;
  followers_count?: number;
}

export interface IgMessage {
  id?: string;
  from?: { id: string; username?: string };
  to?: { data?: Array<{ id: string }> };
  message?: string;
  created_time?: string;
}

export interface IgConversation {
  id: string;
  messages?: { data?: IgMessage[] };
}

export class InstagramClient {
  constructor(
    private readonly accessToken: string,
    private readonly version: string,
    /** The connected account's IG user id; message sends are POSTed to /{igUserId}/messages. */
    private readonly igUserId: string = "me",
  ) {}

  private base(path: string): string {
    return `${GRAPH_HOST}/${this.version}${path.startsWith("/") ? path : `/${path}`}`;
  }

  /** GET with query params; access_token appended automatically. */
  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(this.base(path));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("access_token", this.accessToken);
    const res = await fetch(url.toString(), { method: "GET" });
    return this.parse<T>(res);
  }

  /**
   * POST with parameters in the query string and no body. Graph's edge-management endpoints
   * (e.g. /subscribed_apps) take their arguments this way rather than as a JSON document.
   */
  private async postParams<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(this.base(path));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("access_token", this.accessToken);
    const res = await fetch(url.toString(), { method: "POST" });
    return this.parse<T>(res);
  }

  /** POST JSON body; access_token as a query param (Graph convention). */
  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const url = new URL(this.base(path));
    url.searchParams.set("access_token", this.accessToken);
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return this.parse<T>(res);
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // non-JSON error body
    }
    if (!res.ok) {
      const err = (json as { error?: { message?: string; code?: number; error_subcode?: number; fbtrace_id?: string } })
        ?.error;
      throw new InstagramApiError(
        err?.message ?? `HTTP ${res.status}`,
        res.status,
        err?.code,
        err?.error_subcode,
        err?.fbtrace_id,
      );
    }
    return json as T;
  }

  // ---- messaging (Send API) ----

  /** Send a plain text DM to a user by IGSID. */
  sendText(recipientIgsid: string, text: string): Promise<{ recipient_id?: string; message_id?: string }> {
    return this.post(`/${this.igUserId}/messages`, {
      recipient: { id: recipientIgsid },
      message: { text },
    });
  }

  /** Send a text DM with quick-reply chips (rendered after the thread is accepted). */
  sendQuickReplies(
    recipientIgsid: string,
    text: string,
    quickReplies: QuickReply[],
  ): Promise<{ message_id?: string }> {
    return this.post(`/${this.igUserId}/messages`, {
      recipient: { id: recipientIgsid },
      message: { text, quick_replies: quickReplies },
    });
  }

  /** Send a button-template message with postback buttons (survives the Requests folder). */
  sendButtonTemplate(
    recipient: { igsid?: string; commentId?: string },
    text: string,
    buttons: Button[],
  ): Promise<{ message_id?: string }> {
    return this.post(`/${this.igUserId}/messages`, {
      recipient: recipient.commentId ? { comment_id: recipient.commentId } : { id: recipient.igsid },
      message: {
        attachment: {
          type: "template",
          payload: { template_type: "button", text, buttons },
        },
      },
    });
  }

  /**
   * Open a chat with a fresh commenter via a private reply to their comment. This is the only
   * sanctioned way to DM a new commenter — valid up to 7 days after the comment, once per comment.
   * The opening message uses a button template so it survives the Requests folder (Section: Step 1).
   */
  privateReplyWithButtons(
    commentId: string,
    text: string,
    buttons: Button[],
  ): Promise<{ message_id?: string }> {
    return this.sendButtonTemplate({ commentId }, text, buttons);
  }

  // ---- public comment actions ----

  /** Post a public reply under a comment (text only; publishes asynchronously). */
  replyToComment(commentId: string, message: string): Promise<{ id?: string }> {
    return this.post(`/${commentId}/replies`, { message });
  }

  // ---- webhook subscription ----

  /**
   * Subscribe the connected account to this app's webhooks (MODE=webhook only).
   *
   * Configuring the callback URL in the Meta dashboard subscribes the *app*; this subscribes the
   * *account*, and both are required before any event is delivered. Missing this is the classic
   * "my webhook verified fine but nothing ever arrives" failure — the handshake succeeds because
   * verification only proves the URL answers, not that anything is wired to it.
   */
  subscribeToWebhooks(fields = WEBHOOK_FIELDS): Promise<{ success?: boolean }> {
    return this.postParams(`/${this.igUserId}/subscribed_apps`, { subscribed_fields: fields });
  }

  /** Current webhook field subscriptions for the connected account (diagnostics). */
  async getWebhookSubscriptions(): Promise<Array<{ subscribed_fields?: string[] }>> {
    const res = await this.get<{ data?: Array<{ subscribed_fields?: string[] }> }>(
      `/${this.igUserId}/subscribed_apps`,
    );
    return res.data ?? [];
  }

  // NOTE: there is deliberately no likeComment() here. Instagram's API cannot like a comment.
  // Its comment operations are limited to: read (GET /{media-id}/comments), reply
  // (POST /{comment-id}/replies), delete (DELETE /{comment-id}), hide/unhide
  // (POST /{comment-id}), and enable/disable on media (POST /{media-id}). There is no /likes
  // edge. An earlier version posted to /{comment-id}/likes, which simply errored on every
  // triggering comment.

  // ---- reads ----

  /** Read comments on a media object. Only called for media attached to an active campaign. */
  async getComments(mediaId: string, limit = 50): Promise<IgComment[]> {
    const res = await this.get<{ data?: IgComment[] }>(`/${mediaId}/comments`, {
      fields: "id,text,timestamp,username,from{id,username}",
      limit: String(limit),
    });
    return res.data ?? [];
  }

  /** Read recent conversations + their messages (how inbound taps/replies arrive without webhooks). */
  async getConversations(limit = 20): Promise<IgConversation[]> {
    const res = await this.get<{ data?: IgConversation[] }>(`/${this.igUserId}/conversations`, {
      platform: "instagram",
      fields: "id,messages.limit(10){id,from,to,message,created_time}",
      limit: String(limit),
    });
    return res.data ?? [];
  }

  /**
   * The connected account's profile. Requests only widely-supported fields so OAuth connect never
   * fails on an account where an optional field (e.g. followers_count) isn't returnable; the
   * follower count is fetched separately, on demand, by getFollowersCount.
   */
  getMe(): Promise<IgProfile> {
    return this.get<IgProfile>(`/me`, {
      fields: "user_id,username,account_type,profile_picture_url",
    });
  }

  /** The connected account's media (for the builder media picker + preview). */
  async getMedia(limit = 25): Promise<IgMedia[]> {
    const res = await this.get<{ data?: IgMedia[] }>(`/me/media`, {
      fields: "id,caption,media_type,media_url,thumbnail_url,permalink,like_count,comments_count",
      limit: String(limit),
    });
    return res.data ?? [];
  }

  /**
   * Weak follower-count heuristic for verify_follow_count mode (Section: Step 3). The API cannot
   * verify a specific user's follow; this only reads the account's own follower total.
   */
  async getFollowersCount(): Promise<number | undefined> {
    const me = await this.get<IgProfile>(`/me`, { fields: "followers_count" });
    return me.followers_count;
  }
}

// ---- token endpoints (no access token instance needed) ----

/** Refresh a long-lived token (Section 9). Token must be >24h old and unexpired. */
export async function refreshLongLivedToken(
  version: string,
  accessToken: string,
): Promise<{ access_token: string; expires_in: number }> {
  const url = new URL(`${GRAPH_HOST}/${version}/refresh_access_token`);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", accessToken);
  const res = await fetch(url.toString());
  const text = await res.text();
  if (!res.ok) throw new InstagramApiError(`token refresh failed: ${text}`, res.status);
  return JSON.parse(text) as { access_token: string; expires_in: number };
}

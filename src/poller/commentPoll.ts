// Comment poll (Section 5A). Reads comments only for media attached to an active campaign,
// converts them to normalized events, and feeds the engine. A conservative account-wide hourly
// cap on opening DMs guards the shared rate budget across cron ticks (Section 10).

import { getActiveCampaigns, countEventsGlobal, kvGet, kvSet, now } from "../db";
import type { Runtime } from "../runtime";
import { toUnixSeconds } from "../runtime";
import type { NormalizedComment } from "../types";

// Private replies cap ~750/hr; DMs ~200/hr. Openings are private replies that open a DM, so we
// pace against the stricter DM limit with margin.
const OPENING_CAP_PER_HOUR = 180;

const ERROR_KEY = "last_comment_poll_error";

export async function pollComments(rt: Runtime, db: D1Database): Promise<void> {
  const campaigns = await getActiveCampaigns(db);
  if (campaigns.length === 0) return;

  const sinceHour = now() - 3600;
  const openingsThisHour = await countEventsGlobal(db, "opening_sent", sinceHour);
  if (openingsThisHour >= OPENING_CAP_PER_HOUR) {
    console.warn(`[chatmany] opening cap reached (${openingsThisHour}/hr); deferring comment poll.`);
    return;
  }

  // Dedupe media so shared media across campaigns is fetched once.
  const mediaIds = [...new Set(campaigns.map((c) => c.media_id))];
  let handled = 0;
  let failed = 0;
  let lastError = "";
  for (const mediaId of mediaIds) {
    let comments;
    try {
      comments = await rt.client.getComments(mediaId);
    } catch (e) {
      console.warn(`[chatmany] getComments(${mediaId}) failed: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    for (const c of comments) {
      const igsid = c.from?.id;
      if (!igsid) {
        // Meta's Graph API omits `from.id` for some commenters (permissions/visibility vary by
        // account); without it we can't correlate a later DM reply, so the comment is unreachable.
        // Logged (rather than silently dropped) since this can otherwise look identical to a
        // keyword-matching failure from the outside.
        console.warn(
          `[chatmany] comment ${c.id} on ${mediaId} has no commenter id (from=${JSON.stringify(c.from)}); skipping: "${c.text ?? ""}"`,
        );
        continue;
      }
      const evt: NormalizedComment = {
        kind: "comment",
        comment_id: c.id,
        igsid,
        username: c.from?.username ?? c.username,
        text: c.text ?? "",
        media_id: mediaId,
        timestamp: toUnixSeconds(c.timestamp),
      };
      // Pass the campaigns we already fetched so the engine doesn't re-query per comment.
      // Isolated per comment, for the same reason pollMessages isolates per message: handleComment
      // can throw (a rejected send, a schema mismatch, a malformed campaign), and an unguarded loop
      // lets one poisoned comment abort the whole tick — silently starving every commenter behind
      // it, on this tick and on every tick after, since the same comment is re-read each time.
      // The engine only marks a comment processed once it has fully succeeded, so a comment that
      // throws here is left unprocessed and retried cleanly on the next tick.
      handled++;
      try {
        await rt.engine.handleComment(evt, campaigns);
      } catch (e) {
        failed++;
        lastError = e instanceof Error ? e.message : String(e);
        console.warn(`[chatmany] handleComment failed for ${c.id} on ${mediaId}: ${lastError}`);
      }
    }
  }

  // Isolating each comment stops one failure starving the rest — but it also means a poll in which
  // EVERY comment fails now returns normally, where it used to throw. Without this the dashboard
  // would read healthy while no lead had been answered for hours, which is the exact failure mode
  // the message poll's health signal was added for. Surface it the same way.
  if (failed > 0) {
    await kvSet(db, ERROR_KEY, JSON.stringify({
      at: now(),
      message: `${failed}/${handled} comment(s) failed; last: ${lastError}`.slice(0, 300),
    }));
  } else if (await kvGet(db, ERROR_KEY)) {
    await kvSet(db, ERROR_KEY, "");
  }
}

/** The last comment-poll error, for the status endpoint. Null when the last poll was clean. */
export async function getCommentPollError(db: D1Database): Promise<{ at: number; message: string } | null> {
  const raw = await kvGet(db, ERROR_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { at: number; message: string };
  } catch {
    return null;
  }
}

import { describe, expect, it } from "vitest";
import {
  FOLLOW_PAYLOAD,
  OPENING_PAYLOAD,
  afterFollow,
  afterTap,
  confirmsFollow,
  confirmsTap,
  emailReasksExhausted,
  parsePayload,
  taggedPayload,
} from "../src/engine/transitions";
import type { Campaign } from "../src/types";

function campaign(overrides: Partial<Campaign>): Campaign {
  return {
    campaign_id: "c",
    media_id: "m",
    keywords: ["LINK"],
    reward: { type: "link", value: "https://x.com" },
    copy: { opening: "hi", delivery: "here {reward}" },
    ...overrides,
  };
}

describe("afterTap (Section 6 state machine)", () => {
  it("goes to AWAITING_FOLLOW when check_follow is on", () => {
    expect(afterTap(campaign({ check_follow: true, ask_email: true }))).toBe("AWAITING_FOLLOW");
  });
  it("skips follow, goes to AWAITING_EMAIL when only ask_email is on", () => {
    expect(afterTap(campaign({ ask_email: true }))).toBe("AWAITING_EMAIL");
  });
  it("goes straight to DELIVER when both gates are off ('send immediately')", () => {
    expect(afterTap(campaign({}))).toBe("DELIVER");
  });
});

describe("afterFollow", () => {
  it("goes to AWAITING_EMAIL when ask_email is on", () => {
    expect(afterFollow(campaign({ ask_email: true }))).toBe("AWAITING_EMAIL");
  });
  it("goes to DELIVER otherwise", () => {
    expect(afterFollow(campaign({}))).toBe("DELIVER");
  });
});

describe("email re-ask cap", () => {
  it("allows two nudges, then stops", () => {
    expect(emailReasksExhausted(0)).toBe(false);
    expect(emailReasksExhausted(1)).toBe(false);
    expect(emailReasksExhausted(2)).toBe(true);
    expect(emailReasksExhausted(99)).toBe(true);
  });
});

describe("campaign-tagged button payloads", () => {
  it("round-trips a campaign id", () => {
    expect(parsePayload(taggedPayload(FOLLOW_PAYLOAD, "summer-drop"))).toEqual({
      kind: "FOLLOW_CONFIRM",
      campaignId: "summer-drop",
    });
  });
  it("reads a legacy untagged payload as kind-only", () => {
    // Buttons sent before tagging existed are still in people's inboxes; they must keep working.
    expect(parsePayload("OPENING_TAP")).toEqual({ kind: "OPENING_TAP", campaignId: null });
  });
  it("is empty for no payload at all (a typed reply, or polling mode)", () => {
    expect(parsePayload(undefined)).toEqual({ kind: null, campaignId: null });
    expect(parsePayload("")).toEqual({ kind: null, campaignId: null });
  });
  it("keeps a campaign id that itself contains a colon", () => {
    expect(parsePayload("OPENING_TAP:odd:id").campaignId).toBe("odd:id");
  });
  it("treats a trailing colon as untagged rather than an empty campaign", () => {
    expect(parsePayload("OPENING_TAP:").campaignId).toBeNull();
  });
});

describe("follow-gate confirmation", () => {
  it("accepts our own postback payload (webhook mode)", () => {
    expect(confirmsFollow({ payload: FOLLOW_PAYLOAD })).toBe(true);
  });
  it("rejects a different button's payload so events don't cross-advance", () => {
    expect(confirmsFollow({ payload: "SOME_OTHER_BUTTON" })).toBe(false);
  });
  // These two used to assert the opposite. The lenient fallback was written for polling, which
  // never surfaces a payload — but with a webhook callback registered a real press ALWAYS carries
  // one and a typed message never does, so "no payload" stopped meaning "might be a press" and
  // started meaning "definitely typed". Accepting those handed the reward to people who never
  // pressed anything and never followed anybody.
  it("rejects a payload-less message — typing is not pressing", () => {
    expect(confirmsFollow({ text: "done!" })).toBe(false);
    expect(confirmsFollow({})).toBe(false);
  });
  it("rejects a typed reply even when it reads like a confirmation", () => {
    expect(confirmsFollow({ text: "i followed" })).toBe(false);
    expect(confirmsFollow({ text: "✅ I followed" })).toBe(false);
  });
});

describe("opening-tap confirmation", () => {
  it("accepts our own opening payload, tagged with the campaign", () => {
    expect(confirmsTap({ payload: OPENING_PAYLOAD })).toBe(true);
    expect(confirmsTap({ payload: `${OPENING_PAYLOAD}:c1` })).toBe(true);
  });
  it("rejects the follow gate's payload, so the two steps cannot cross-advance", () => {
    expect(confirmsTap({ payload: FOLLOW_PAYLOAD })).toBe(false);
  });
  it("rejects a foreign button's payload", () => {
    expect(confirmsTap({ payload: "SOME_OTHER_BUTTON" })).toBe(false);
  });
  // The reported bug: someone ignores the button, types "hey", and gets pulled through the funnel.
  it("rejects a payload-less message — the reported bug", () => {
    expect(confirmsTap({})).toBe(false);
  });
});


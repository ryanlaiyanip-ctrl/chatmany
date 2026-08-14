import { describe, expect, it } from "vitest";
import { FOLLOW_PAYLOAD, afterFollow, afterTap, confirmsFollow } from "../src/engine/transitions";
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

describe("follow-gate confirmation", () => {
  it("accepts our own postback payload (webhook mode)", () => {
    expect(confirmsFollow({ payload: FOLLOW_PAYLOAD })).toBe(true);
  });
  it("rejects a different button's payload so events don't cross-advance", () => {
    expect(confirmsFollow({ payload: "SOME_OTHER_BUTTON" })).toBe(false);
  });
  it("accepts a payload-less message — polling never surfaces the postback payload", () => {
    expect(confirmsFollow({ text: "done!" })).toBe(true);
    expect(confirmsFollow({})).toBe(true);
  });
  it("accepts a typed reply that the old exact-title rule would have ignored", () => {
    // "i followed" without the emoji left people stuck in AWAITING_FOLLOW before.
    expect(confirmsFollow({ text: "i followed" })).toBe(true);
  });
});

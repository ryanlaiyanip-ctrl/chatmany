import { describe, expect, it } from "vitest";
import { pollIntervalSeconds } from "../src/runtime";
import type { Env } from "../src/types";

const env = (over: Partial<Env> = {}): Env =>
  ({ MODE: "polling", POLL_INTERVAL_SECONDS: "90", ...over }) as Env;

describe("polling mode", () => {
  it("uses POLL_INTERVAL_SECONDS", () => {
    expect(pollIntervalSeconds(env({ POLL_INTERVAL_SECONDS: "120" }))).toBe(120);
  });
  it("floors at the cron granularity so we never try to out-poll the every-minute trigger", () => {
    expect(pollIntervalSeconds(env({ POLL_INTERVAL_SECONDS: "5" }))).toBe(30);
  });
  it("falls back to 90s when unset or unparseable", () => {
    expect(pollIntervalSeconds(env({ POLL_INTERVAL_SECONDS: "" }))).toBe(90);
    expect(pollIntervalSeconds(env({ POLL_INTERVAL_SECONDS: "soon" }))).toBe(90);
  });
  it("ignores WEBHOOK_RECONCILE_SECONDS entirely", () => {
    expect(pollIntervalSeconds(env({ WEBHOOK_RECONCILE_SECONDS: "off" }))).toBe(90);
  });
});

describe("webhook mode", () => {
  const wh = (over: Partial<Env> = {}) => env({ MODE: "webhook", ...over });

  it("still polls, but slowly — push alone drops leads Meta gives up retrying", () => {
    expect(pollIntervalSeconds(wh())).toBe(900);
  });
  it("honours an explicit reconcile interval", () => {
    expect(pollIntervalSeconds(wh({ WEBHOOK_RECONCILE_SECONDS: "300" }))).toBe(300);
  });
  it("can be turned off entirely for pure push", () => {
    expect(pollIntervalSeconds(wh({ WEBHOOK_RECONCILE_SECONDS: "off" }))).toBeNull();
    expect(pollIntervalSeconds(wh({ WEBHOOK_RECONCILE_SECONDS: "0" }))).toBeNull();
    expect(pollIntervalSeconds(wh({ WEBHOOK_RECONCILE_SECONDS: "false" }))).toBeNull();
  });
  it("treats unset as on, not off — the safety net is opt-out", () => {
    expect(pollIntervalSeconds(wh({ WEBHOOK_RECONCILE_SECONDS: undefined }))).toBe(900);
  });
  it("ignores POLL_INTERVAL_SECONDS, so switching modes can't leave a fast poll running", () => {
    expect(pollIntervalSeconds(wh({ POLL_INTERVAL_SECONDS: "30" }))).toBe(900);
  });
  it("floors at the cron granularity", () => {
    expect(pollIntervalSeconds(wh({ WEBHOOK_RECONCILE_SECONDS: "5" }))).toBe(30);
  });
});

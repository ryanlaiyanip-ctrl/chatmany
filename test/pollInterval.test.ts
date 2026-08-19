import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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

/**
 * Guards the out-of-the-box experience for anyone cloning the repo.
 *
 * wrangler.toml is what a fresh clone deploys with. It once shipped MODE = "webhook", which needs
 * Meta-side setup nobody has done yet at that point — so no push events arrived, the only thing
 * running was the 15-minute reconciliation sweep, and every DM looked ~15 minutes late. Polling
 * works immediately with no Meta setup, so that is what must ship.
 */
describe("the default config a fresh clone deploys", () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const varOf = (k: string) => toml.match(new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, "m"))?.[1];

  it("ships polling, not webhook", () => {
    expect(varOf("MODE")).toBe("polling");
  });

  it("reaches someone within ~90 seconds, not minutes", () => {
    const env = {
      MODE: varOf("MODE"),
      POLL_INTERVAL_SECONDS: varOf("POLL_INTERVAL_SECONDS"),
      WEBHOOK_RECONCILE_SECONDS: varOf("WEBHOOK_RECONCILE_SECONDS"),
    } as unknown as Env;
    const interval = pollIntervalSeconds(env);
    expect(interval).not.toBeNull();
    expect(interval!).toBeLessThanOrEqual(90);
  });
});

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const posthog = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  register: vi.fn(),
  identify: vi.fn(),
  setPersonProperties: vi.fn(),
}));

vi.mock("posthog-js", () => ({ default: posthog }));

import { FIRST_TOUCH_KEY } from "./attribution";
import {
  captureGrowthEvent,
  capturePageview,
  captureWalletConnected,
  initGrowthAnalytics,
  posthogApiHost,
  posthogProjectKey,
  resetGrowthAnalyticsForTests,
} from "./client";
import { GROWTH_EVENTS } from "./events";
import { hashWallet } from "./hash-wallet";

beforeEach(() => {
  resetGrowthAnalyticsForTests();
  window.localStorage.clear();
  vi.unstubAllEnvs();
  Object.defineProperty(navigator, "doNotTrack", { configurable: true, value: "0" });
});
afterEach(() => {
  resetGrowthAnalyticsForTests();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("PostHog no-op when the public key is unset", () => {
  it("does not init or capture when NEXT_PUBLIC_POSTHOG_KEY is missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
    expect(posthogProjectKey()).toBeUndefined();
    captureGrowthEvent(GROWTH_EVENTS.rwaPairsView, { ref: "x-test" });
    await initGrowthAnalytics();
    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it("uses the first-party relay and still no-ops when the key is blank", () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", undefined);
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", undefined);
    expect(posthogApiHost()).toBe("/lumen");
    capturePageview("/", "https://sofinancelab.xyz/");
    expect(posthog.capture).not.toHaveBeenCalled();
  });
});

describe("event firing when the key is set", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "https://us.i.posthog.com");
  });

  it("inits once, captures pageviews, and keeps first-touch ref on later events", async () => {
    window.history.replaceState({}, "", "/app/rwa-pairs?ref=x-launch&utm_source=twitter");
    expect(await initGrowthAnalytics(window.location.search)).toBe(true);
    expect(posthog.init).toHaveBeenCalledWith("phc_test", expect.objectContaining({
      api_host: "/lumen",
      ui_host: "https://us.posthog.com",
      autocapture: false,
      capture_pageview: false,
      capture_heatmaps: false,
      capture_performance: false,
      disable_session_recording: true,
      respect_dnt: true,
    }));
    expect(posthog.register).toHaveBeenCalledWith(expect.objectContaining({ ref: "x-launch", utm_source: "twitter" }));
    capturePageview("/app/rwa-pairs", "https://sofinancelab.xyz/app/rwa-pairs?ref=x-launch");
    captureGrowthEvent(GROWTH_EVENTS.rwaPairsView, { ref: "x-launch" });
    captureGrowthEvent(GROWTH_EVENTS.openStarted, { pair: "HOODx/HOOD" });
    expect(posthog.capture.mock.calls.map((call) => call[0])).toEqual([
      "$pageview", GROWTH_EVENTS.rwaPairsView, GROWTH_EVENTS.openStarted,
    ]);
    expect(JSON.parse(window.localStorage.getItem(FIRST_TOUCH_KEY)!)).toMatchObject({ ref: "x-launch" });
  });

  it("identifies a hashed wallet and never sends the address as an event property", async () => {
    const wallet = "So11111111111111111111111111111111111111112";
    await initGrowthAnalytics();
    await captureWalletConnected(wallet);
    expect(posthog.identify).toHaveBeenCalledWith(`wallet:${await hashWallet(wallet)}`);
    expect(posthog.capture).toHaveBeenCalledWith(GROWTH_EVENTS.walletConnected, undefined);
    captureGrowthEvent(GROWTH_EVENTS.openSuccess, { wallet, pool: "pool" });
    expect(posthog.capture).toHaveBeenLastCalledWith(GROWTH_EVENTS.openSuccess, { pool: "pool" });
  });

  it("respects Do Not Track without initializing", async () => {
    Object.defineProperty(navigator, "doNotTrack", { configurable: true, value: "1" });
    expect(await initGrowthAnalytics()).toBe(false);
    captureGrowthEvent(GROWTH_EVENTS.walletConnected);
    expect(posthog.init).not.toHaveBeenCalled();
  });
});

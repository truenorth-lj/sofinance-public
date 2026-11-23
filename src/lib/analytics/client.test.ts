// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const posthog = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  register: vi.fn(),
  identify: vi.fn(),
  setPersonProperties: vi.fn(),
  unregister: vi.fn(),
  reset: vi.fn(),
  get_distinct_id: vi.fn((): string => "0192f0c4-anon"),
}));

vi.mock("posthog-js", () => ({ default: posthog }));

import { FIRST_TOUCH_KEY } from "./attribution";
import {
  captureGrowthEvent,
  capturePageview,
  captureWalletConnected,
  captureWalletDisconnected,
  initGrowthAnalytics,
  posthogApiHost,
  posthogProjectKey,
  resetGrowthAnalyticsForTests,
} from "./client";
import { GROWTH_EVENTS } from "./events";
import { walletDistinctId } from "./server-capture";
const WALLETS = ["7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr"];

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

  it("concurrent callers share one in-flight init, so posthog.init runs exactly once", async () => {
    const results = await Promise.all([initGrowthAnalytics(), initGrowthAnalytics("?ref=a")]);
    expect(results).toEqual([true, true]);
    expect(posthog.init).toHaveBeenCalledTimes(1);
    expect(await initGrowthAnalytics()).toBe(true);
    expect(posthog.init).toHaveBeenCalledTimes(1);
  });

  it("inits once, captures pageviews, and keeps first-touch ref on later events", async () => {
    window.history.replaceState({}, "", "/pools?ref=x-launch&utm_source=twitter");
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
    // Older builds persisted the raw address as a super property; init drops it.
    expect(posthog.unregister).toHaveBeenCalledWith("wallet_address");
    expect(posthog.register).toHaveBeenCalledWith(expect.objectContaining({ ref: "x-launch", utm_source: "twitter" }));
    capturePageview("/pools", "https://sofinancelab.xyz/pools?ref=x-launch");
    captureGrowthEvent(GROWTH_EVENTS.rwaPairsView, { ref: "x-launch" });
    captureGrowthEvent(GROWTH_EVENTS.openStarted, { pair: "HOODx/HOOD" });
    expect(posthog.capture.mock.calls.map((call) => call[0])).toEqual([
      "$pageview", GROWTH_EVENTS.rwaPairsView, GROWTH_EVENTS.openStarted,
    ]);
    expect(JSON.parse(window.localStorage.getItem(FIRST_TOUCH_KEY)!)).toMatchObject({ ref: "x-launch" });
  });

  it("identifies by the hashed wallet id, the same id as the MCP server, and never sends the raw address", async () => {
    const wallet = "So11111111111111111111111111111111111111112";
    await initGrowthAnalytics();
    await captureWalletConnected(wallet);
    expect(posthog.reset).not.toHaveBeenCalled();
    expect(posthog.identify).toHaveBeenCalledWith(walletDistinctId(wallet));
    expect(posthog.capture).toHaveBeenCalledWith(GROWTH_EVENTS.walletConnected, undefined);
    // Wallet keys are stripped from any event, including the old `wallet_address`.
    captureGrowthEvent(GROWTH_EVENTS.openSuccess, { wallet, wallet_address: wallet, address: wallet, pool: "pool" });
    expect(posthog.capture).toHaveBeenLastCalledWith(GROWTH_EVENTS.openSuccess, { pool: "pool" });
    const sent = JSON.stringify([posthog.identify.mock.calls, posthog.register.mock.calls,
      posthog.setPersonProperties.mock.calls, posthog.capture.mock.calls]);
    expect(sent).not.toContain(wallet);
  });

  it("attaches connect context to wallet_connected only", async () => {
    const wallet = "So11111111111111111111111111111111111111112";
    await initGrowthAnalytics();
    posthog.register.mockClear();
    posthog.setPersonProperties.mockClear();
    await captureWalletConnected(wallet, { wallet_name: "Phantom", chain: "solana", device: "desktop", wallet_extension_detected: true });
    expect(posthog.identify).toHaveBeenCalledWith(walletDistinctId(wallet));
    expect(posthog.register).not.toHaveBeenCalled();
    expect(posthog.setPersonProperties).not.toHaveBeenCalled();
    expect(posthog.capture).toHaveBeenCalledWith(GROWTH_EVENTS.walletConnected, {
      wallet_name: "Phantom", chain: "solana", device: "desktop", wallet_extension_detected: true,
    });
  });

  it("resets an earlier wallet identity (raw address from older builds, or another hashed id) before identifying", async () => {
    await initGrowthAnalytics();
    // Same wallet, raw id from an older build: reset, so the raw-address person is not merged into the hashed id.
    posthog.get_distinct_id.mockReturnValueOnce(WALLETS[1]!);
    await captureWalletConnected(WALLETS[1]!);
    expect(posthog.reset).toHaveBeenCalledTimes(1);
    posthog.get_distinct_id.mockReturnValueOnce(walletDistinctId(WALLETS[1]!));
    await captureWalletConnected(WALLETS[2]!);
    expect(posthog.reset).toHaveBeenCalledTimes(2);
    posthog.get_distinct_id.mockReturnValueOnce(walletDistinctId(WALLETS[2]!));
    await captureWalletConnected(WALLETS[2]!);
    expect(posthog.reset).toHaveBeenCalledTimes(2);
    expect(posthog.identify.mock.calls.map(([id]) => id)).toEqual([
      walletDistinctId(WALLETS[1]!), walletDistinctId(WALLETS[2]!), walletDistinctId(WALLETS[2]!),
    ]);
  });

  it("drops the wallet tags and resets on disconnect, keeping first-touch attribution", async () => {
    window.history.replaceState({}, "", "/app?ref=x-launch");
    await initGrowthAnalytics(window.location.search);
    captureWalletDisconnected();
    expect(posthog.reset).not.toHaveBeenCalled();
    await captureWalletConnected(WALLETS[0]!);
    posthog.register.mockClear();
    captureWalletDisconnected();
    expect(posthog.unregister).toHaveBeenCalledWith("wallet_address");
    expect(posthog.reset).toHaveBeenCalledTimes(1);
    expect(posthog.register).toHaveBeenCalledWith(expect.objectContaining({ ref: "x-launch" }));
    captureWalletDisconnected();
    expect(posthog.reset).toHaveBeenCalledTimes(1);
  });

  it("respects Do Not Track without initializing", async () => {
    Object.defineProperty(navigator, "doNotTrack", { configurable: true, value: "1" });
    expect(await initGrowthAnalytics()).toBe(false);
    captureGrowthEvent(GROWTH_EVENTS.walletConnected);
    expect(posthog.init).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installGrowthClientForTests, resetGrowthAnalyticsForTests } from "./client";
import { GROWTH_EVENTS } from "./events";
import {
  captureWalletConnectAbandoned,
  captureWalletConnectFailed,
  captureWalletConnectStarted,
  captureWalletDeeplinkClicked,
  noteWalletConnectSucceeded,
  openWalletConnectSession,
  resetWalletConnectSessionForTests,
  walletConnectAttemptForTests,
} from "./wallet-connect-session";

const capture = vi.fn();

beforeEach(() => {
  resetGrowthAnalyticsForTests();
  resetWalletConnectSessionForTests();
  capture.mockReset();
  installGrowthClientForTests({ capture, register: vi.fn(), identify: vi.fn() });
});
afterEach(() => {
  resetWalletConnectSessionForTests();
  resetGrowthAnalyticsForTests();
});

const session = { chain: "solana" as const, device: "desktop" as const, wallet_extension_detected: true };

describe("wallet connect attempt session", () => {
  it("does not fire abandoned after a successful connect, and will not fire it twice", () => {
    openWalletConnectSession(session);
    captureWalletConnectStarted({ wallet_name: "Phantom", ...session });
    noteWalletConnectSucceeded();
    captureWalletConnectAbandoned();
    captureWalletConnectAbandoned();
    expect(capture.mock.calls.map((call) => call[0])).toEqual([GROWTH_EVENTS.walletConnectStarted]);
  });

  it("does not fire abandoned after a failed connect", () => {
    openWalletConnectSession(session);
    captureWalletConnectStarted({ wallet_name: "Solflare", ...session });
    captureWalletConnectFailed(Object.assign(new Error("User rejected the request."), { code: 4001 }), { wallet_name: "Solflare" });
    captureWalletConnectAbandoned();
    const events = capture.mock.calls.map((call) => call[0]);
    expect(events).toEqual([GROWTH_EVENTS.walletConnectStarted, GROWTH_EVENTS.walletConnectFailed]);
    expect(capture.mock.calls[1]![1]).toMatchObject({
      wallet_name: "Solflare", chain: "solana", device: "desktop", wallet_extension_detected: true,
      error_type: "user_rejected",
    });
    expect(walletConnectAttemptForTests()?.outcome).toBe("failed");
  });

  it("fires abandoned once when the modal is closed with no success or failure", () => {
    openWalletConnectSession(session);
    captureWalletConnectAbandoned();
    captureWalletConnectAbandoned();
    expect(capture.mock.calls).toEqual([
      [GROWTH_EVENTS.walletConnectAbandoned, expect.objectContaining({ chain: "solana", device: "desktop", wallet_extension_detected: true })],
    ]);
  });

  it("records a deeplink click as started plus wallet_deeplink_clicked, and still skips abandoned after success", () => {
    openWalletConnectSession({ ...session, device: "mobile", wallet_extension_detected: false });
    captureWalletDeeplinkClicked("Phantom", { device: "mobile", wallet_extension_detected: false });
    noteWalletConnectSucceeded();
    captureWalletConnectAbandoned();
    expect(capture.mock.calls.map((call) => call[0])).toEqual([
      GROWTH_EVENTS.walletConnectStarted, GROWTH_EVENTS.walletDeeplinkClicked,
    ]);
    expect(capture.mock.calls[1]![1]).toMatchObject({
      wallet_name: "Phantom", chain: "solana", device: "mobile", wallet_extension_detected: false,
    });
  });
});

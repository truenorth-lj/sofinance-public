// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appkit = vi.hoisted(() => ({
  events: { timestamp: 1, data: { event: "MODAL_CREATED", properties: {} } as { event: string; properties: Record<string, unknown> } },
  connectingWallet: undefined as { name?: string } | undefined,
}));

vi.mock("@reown/appkit/react", () => ({
  useAppKitEvents: () => appkit.events,
  useAppKitState: () => ({ connectingWallet: appkit.connectingWallet }),
}));

import { installGrowthClientForTests, resetGrowthAnalyticsForTests } from "@/lib/analytics/client";
import { GROWTH_EVENTS } from "@/lib/analytics/events";
import { resetWalletConnectSessionForTests, openWalletConnectSession, noteWalletConnectSucceeded } from "@/lib/analytics/wallet-connect-session";
import { AppKitConnectAnalytics } from "./appkit-connect-analytics";

const capture = vi.fn();
let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => { root.render(createElement(AppKitConnectAnalytics)); });
}

async function emit(event: string, properties: Record<string, unknown> = {}) {
  appkit.events = { timestamp: appkit.events.timestamp + 1, data: { event, properties } };
  await render();
}

describe("AppKitConnectAnalytics", () => {
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    resetGrowthAnalyticsForTests();
    resetWalletConnectSessionForTests();
    capture.mockReset();
    installGrowthClientForTests({ capture, register: vi.fn(), identify: vi.fn() });
    appkit.events = { timestamp: 1, data: { event: "MODAL_CREATED", properties: {} } };
    appkit.connectingWallet = undefined;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await render();
    openWalletConnectSession({ chain: "solana", device: "desktop", wallet_extension_detected: true });
    capture.mockClear();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetGrowthAnalyticsForTests();
    resetWalletConnectSessionForTests();
    vi.unstubAllGlobals();
  });

  it("starts on SELECT_WALLET, fails on USER_REJECTED, and does not abandon after failure", async () => {
    await emit("SELECT_WALLET", { name: "Phantom" });
    expect(capture).toHaveBeenCalledWith(GROWTH_EVENTS.walletConnectStarted, expect.objectContaining({
      wallet_name: "Phantom", chain: "solana",
    }));
    await emit("USER_REJECTED", { name: "Phantom", message: "User rejected the request." });
    expect(capture).toHaveBeenCalledWith(GROWTH_EVENTS.walletConnectFailed, expect.objectContaining({
      wallet_name: "Phantom", error_type: "user_rejected",
    }));
    capture.mockClear();
    await emit("MODAL_CLOSE", { connected: false });
    expect(capture).not.toHaveBeenCalledWith(GROWTH_EVENTS.walletConnectAbandoned, expect.anything());
  });

  it("does not abandon after a successful connect", async () => {
    await emit("SELECT_WALLET", { name: "Solflare" });
    await emit("CONNECT_SUCCESS", { name: "Solflare" });
    noteWalletConnectSucceeded();
    capture.mockClear();
    await emit("MODAL_CLOSE", { connected: true });
    expect(capture.mock.calls.map((call) => call[0])).not.toContain(GROWTH_EVENTS.walletConnectAbandoned);
  });

  it("abandons when the modal closes with no outcome", async () => {
    await emit("MODAL_CLOSE", { connected: false });
    expect(capture).toHaveBeenCalledWith(GROWTH_EVENTS.walletConnectAbandoned, expect.objectContaining({ chain: "solana" }));
  });
});

// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wallet = vi.hoisted(() => ({
  visible: false,
  connected: false,
  connecting: false,
  name: "Backpack" as string | undefined,
  errorHandlers: [] as Array<(error: unknown) => void>,
}));

vi.mock("@solana/wallet-adapter-react-ui", () => ({
  useWalletModal: () => ({ visible: wallet.visible }),
}));
vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => ({
    connected: wallet.connected,
    connecting: wallet.connecting,
    wallet: wallet.name ? { adapter: {
      name: wallet.name,
      on: (_event: string, fn: (error: unknown) => void) => { wallet.errorHandlers.push(fn); },
      off: () => { wallet.errorHandlers.length = 0; },
    } } : null,
  }),
}));

import { installGrowthClientForTests, resetGrowthAnalyticsForTests } from "@/lib/analytics/client";
import { GROWTH_EVENTS } from "@/lib/analytics/events";
import { openWalletConnectSession, resetWalletConnectSessionForTests } from "@/lib/analytics/wallet-connect-session";
import { AdapterConnectAnalytics } from "./adapter-connect-analytics";

const capture = vi.fn();
let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => { root.render(createElement(AdapterConnectAnalytics)); });
}

describe("AdapterConnectAnalytics", () => {
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    resetGrowthAnalyticsForTests();
    resetWalletConnectSessionForTests();
    capture.mockReset();
    installGrowthClientForTests({ capture, register: vi.fn(), identify: vi.fn() });
    Object.assign(wallet, { visible: false, connected: false, connecting: false, name: "Backpack", errorHandlers: [] });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    openWalletConnectSession({ chain: "solana", device: "desktop", wallet_extension_detected: true });
    await render();
    capture.mockClear();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetGrowthAnalyticsForTests();
    resetWalletConnectSessionForTests();
    vi.unstubAllGlobals();
  });

  it("starts when a wallet is selected, fails on adapter error, and does not abandon afterwards", async () => {
    wallet.visible = true;
    wallet.connecting = true;
    await render();
    expect(capture).toHaveBeenCalledWith(GROWTH_EVENTS.walletConnectStarted, expect.objectContaining({
      wallet_name: "Backpack", chain: "solana",
    }));
    await act(async () => { wallet.errorHandlers[0]?.(Object.assign(new Error("User rejected the request."), { code: 4001 })); });
    expect(capture).toHaveBeenCalledWith(GROWTH_EVENTS.walletConnectFailed, expect.objectContaining({
      wallet_name: "Backpack", error_type: "user_rejected",
    }));
    capture.mockClear();
    wallet.visible = false;
    wallet.connecting = false;
    await render();
    expect(capture.mock.calls.map((call) => call[0])).not.toContain(GROWTH_EVENTS.walletConnectAbandoned);
  });

  it("abandons when the modal closes without a connect, and not a second time", async () => {
    wallet.visible = true;
    await render();
    capture.mockClear();
    wallet.visible = false;
    await render();
    await render();
    expect(capture.mock.calls.filter((call) => call[0] === GROWTH_EVENTS.walletConnectAbandoned)).toHaveLength(1);
  });
});

// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletConnectionContext, type WalletConnection } from "@/components/wallet-connection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Like the real BrowserWalletConnection: a fresh value with fresh functions on every render.
const provider = vi.hoisted(() => ({ renders: 0, disconnects: [] as number[] }));
vi.mock("@/components/providers", async () => {
  const { createElement: h } = await import("react");
  return {
    Providers: ({ children }: { children: ReactNode }) => {
      const render = ++provider.renders;
      return h(WalletConnectionContext.Provider, { value: {
        address: "4mLbQ1zcfAWJx3fNPbXwVWr2sE8ZKkQyVxv9X5kUUK7", connected: true, connect: () => {},
        disconnect: () => { provider.disconnects.push(render); }, isMobile: false, walletsCount: 1, connectionError: "",
        signTransaction: async (transaction) => transaction,
      } as WalletConnection }, children);
    },
  };
});
vi.mock("@/components/stocks/spot-swap-modal", () => ({ SpotSwapModal: () => null }));

const { homepageWallet } = await import("./homepage-wallet");
const { HomepageWalletRoot } = await import("./homepage-wallet-root");

beforeEach(() => { homepageWallet.reset(); provider.renders = 0; provider.disconnects = []; });
afterEach(() => { document.body.innerHTML = ""; });

describe("HomepageWalletRoot with a connected wallet", () => {
  it("does not re-render in a loop when the provider hands out new functions every render (was: Maximum update depth exceeded)", async () => {
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root.render(createElement(HomepageWalletRoot)));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(provider.renders).toBeLessThan(5);
    expect(homepageWallet.get()).toMatchObject({ ready: true, address: "4mLbQ1zcfAWJx3fNPbXwVWr2sE8ZKkQyVxv9X5kUUK7" });
    // Disconnect reaches the provider's latest function.
    homepageWallet.disconnect();
    expect(provider.disconnects).toEqual([provider.renders]);
    await act(async () => root.unmount());
  });

  it("forgets the wallet when the root unmounts (the visitor left the homepage), so nothing stale is shown on return", async () => {
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root.render(createElement(HomepageWalletRoot)));
    await act(async () => root.unmount());
    expect(homepageWallet.get()).toMatchObject({ ready: false, address: null, buy: null });
    homepageWallet.disconnect();
    expect(provider.disconnects).toEqual([]);
  });
});

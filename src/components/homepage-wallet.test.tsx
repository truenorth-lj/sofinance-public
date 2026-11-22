// @vitest-environment happy-dom
import { act, createElement, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletConnectionContext, type WalletConnection } from "@/components/wallet-connection";
import type { StockBuyOption } from "@/lib/stock-market/public";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The real providers need wallets and an RPC; here they hand down whatever `wallet` says.
const wallet = vi.hoisted(() => ({ value: null as unknown as WalletConnection, providerMounts: 0 }));
vi.mock("@/components/providers", async () => {
  const { createElement: h, useEffect } = await import("react");
  return {
    Providers: ({ children }: { children: ReactNode }) => {
      useEffect(() => { wallet.providerMounts += 1; }, []);
      return h(WalletConnectionContext.Provider, { value: wallet.value }, children);
    },
  };
});
vi.mock("@/components/stocks/spot-swap-modal", () => ({
  SpotSwapModal: ({ option }: { option: StockBuyOption }) => createElement("div", { "data-testid": "buy-modal" }, `Buy ${option.company}`),
}));
// next/dynamic resolves the root directly in tests.
vi.mock("next/dynamic", async () => {
  const { HomepageWalletRoot } = await import("./homepage-wallet-root");
  return { default: () => HomepageWalletRoot };
});

const { homepageWallet, REMEMBERED_WALLET_KEY } = await import("./homepage-wallet");
const { HomepageConnectButton, HomepageWalletIsland } = await import("./homepage-wallet-island");
const { StockCards } = await import("./stocks/stock-cards");

const ADDRESS = "4mLbQ1zcfAWJx3fNPbXwVWr2sE8ZKkQyVxv9X5kUUK7";
const tesla: StockBuyOption = { underlying: "TSLA", company: "Tesla", mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", mintShort: "XsDo…HzoB", issuerName: "xStocks", symbol: "TSLAx" };

function connection(patch: Partial<WalletConnection> = {}): WalletConnection {
  return {
    address: undefined, connected: false, connect: vi.fn(), disconnect: vi.fn(), isMobile: false, walletsCount: 1,
    connectionError: "", signTransaction: vi.fn(), ...patch,
  };
}

let host: HTMLDivElement; let root: Root;
beforeEach(() => {
  homepageWallet.reset();
  wallet.value = connection(); wallet.providerMounts = 0;
  window.localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const page = () => createElement("div", null, createElement(HomepageConnectButton), createElement(HomepageWalletIsland));
const button = () => host.querySelector<HTMLButtonElement>("[data-testid=home-wallet]")!;

describe("homepage wallet", () => {
  it("regression: restores an AppKit session without the legacy walletName key", async () => {
    window.localStorage.setItem("@appkit/solana:connected_connector_id", "Phantom");
    wallet.value = connection({ address: ADDRESS, connected: true });
    await act(async () => root.render(page()));
    expect(wallet.providerMounts).toBe(1);
    expect(button().getAttribute("data-connected")).toBe("true");
    expect(wallet.value.connect).not.toHaveBeenCalled();
  });

  it("regression: a click during async session restoration does not open a redundant picker", async () => {
    const connect = vi.fn();
    wallet.value = connection({ connect, restoring: true });
    await act(async () => root.render(page()));
    await act(async () => button().click());
    expect(button().textContent).toBe("Connecting…");
    expect(button().disabled).toBe(true);
    expect(homepageWallet.get().ready).toBe(false);
    expect(connect).not.toHaveBeenCalled();
    // The SDK later restores the previously authorized wallet, without another user action.
    wallet.value = connection({ address: ADDRESS, connected: true, connect });
    await act(async () => root.render(page()));
    expect(button().getAttribute("data-connected")).toBe("true");
    expect(connect).not.toHaveBeenCalled();
  });

  it("opens the picker once after a requested restoration finishes without a wallet", async () => {
    const connect = vi.fn();
    wallet.value = connection({ connect, restoring: true });
    await act(async () => root.render(page()));
    await act(async () => button().click());
    await act(async () => button().click());
    expect(connect).not.toHaveBeenCalled();
    wallet.value = connection({ connect, restoring: false });
    await act(async () => root.render(page()));
    expect(connect).toHaveBeenCalledTimes(1);
    expect(button().textContent).toBe("Connect wallet");
    expect(button().disabled).toBe(false);
    await act(async () => root.render(page()));
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("does not show a cached address or open a picker when background restoration fails", async () => {
    window.localStorage.setItem("@appkit/connections", JSON.stringify({ solana: [{ accounts: [{ address: ADDRESS }] }] }));
    const connect = vi.fn();
    wallet.value = connection({ connect, restoring: true });
    await act(async () => root.render(page()));
    expect(wallet.providerMounts).toBe(1);
    expect(button().textContent).toBe("Connecting…");
    expect(button().getAttribute("data-connected")).toBe("false");
    wallet.value = connection({ connect, restoring: false });
    await act(async () => root.render(page()));
    expect(button().textContent).toBe("Connect wallet");
    expect(connect).not.toHaveBeenCalled();
  });

  it.each(["null", "{}", '{"solana":[]}', '{"eip155":[{}]}', "broken JSON"])("does not load providers for an absent Solana session: %s", async (stored) => {
    window.localStorage.setItem("@appkit/connections", stored);
    await act(async () => root.render(page()));
    expect(wallet.providerMounts).toBe(0);
    expect(button().textContent).toBe("Connect wallet");
  });

  it("leaves connecting available when storage access is blocked", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    try {
      await act(async () => root.render(page()));
      expect(wallet.providerMounts).toBe(0);
      await act(async () => button().click());
      expect(wallet.value.connect).toHaveBeenCalledTimes(1);
    } finally { getItem.mockRestore(); }
  });

  it("cancels a pending click on navigation while restoration is still running", async () => {
    const connect = vi.fn();
    wallet.value = connection({ connect, restoring: true });
    await act(async () => root.render(page()));
    await act(async () => button().click());
    expect(connect).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    root = createRoot(host);
    wallet.value = connection({ connect, restoring: false });
    await act(async () => root.render(page()));
    expect(connect).not.toHaveBeenCalled();
    await act(async () => button().click());
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("keeps a requested connect across Strict Mode's provider effect replay", async () => {
    const connect = vi.fn();
    wallet.value = connection({ connect, restoring: true });
    const strictPage = () => createElement(StrictMode, null, page());
    await act(async () => root.render(strictPage()));
    await act(async () => button().click());
    expect(connect).not.toHaveBeenCalled();
    wallet.value = connection({ connect, restoring: false });
    await act(async () => root.render(strictPage()));
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("loads nothing until it is needed: no remembered wallet, no click, no providers", async () => {
    await act(async () => root.render(page()));
    expect(button().textContent).toBe("Connect wallet");
    expect(wallet.providerMounts).toBe(0);
  });

  it("after a retry dropped a stuck restore and reloaded, the providers load even though no wallet is remembered", async () => {
    window.sessionStorage.setItem("sofi:open-wallet-picker", "1");
    await act(async () => root.render(page()));
    expect(wallet.providerMounts).toBe(1);
    window.sessionStorage.clear();
  });

  it("Connect wallet loads the providers in place and opens the wallet picker once per click", async () => {
    await act(async () => root.render(page()));
    await act(async () => button().click());
    expect(wallet.providerMounts).toBe(1);
    expect(wallet.value.connect).toHaveBeenCalledTimes(1);
    await act(async () => button().click());
    expect(wallet.value.connect).toHaveBeenCalledTimes(2);
    // Still one providers tree.
    expect(wallet.providerMounts).toBe(1);
  });

  it("leaving the homepage and coming back does not replay an old Connect wallet click (no picker opens by itself)", async () => {
    await act(async () => root.render(page()));
    await act(async () => button().click());
    expect(wallet.value.connect).toHaveBeenCalledTimes(1);
    // The visitor dismisses the picker without connecting, goes to another page (the homepage unmounts)…
    await act(async () => root.unmount());
    // …and comes back: a new island and root mount, with the click count still in the store.
    root = createRoot(host);
    await act(async () => root.render(page()));
    expect(wallet.providerMounts).toBe(2);
    expect(wallet.value.connect).toHaveBeenCalledTimes(1);
    // A new click still opens it.
    await act(async () => button().click());
    expect(wallet.value.connect).toHaveBeenCalledTimes(2);
  });

  it("shows the connected wallet like the app bar, and a click disconnects it", async () => {
    wallet.value = connection({ address: ADDRESS, connected: true });
    await act(async () => root.render(page()));
    await act(async () => homepageWallet.mount());
    expect(button().getAttribute("data-connected")).toBe("true");
    expect(button().textContent).toBe("4mLb…UUK7SOL");
    expect(button().getAttribute("aria-label")).toBe("Solana wallet 4mLb…UUK7, connected. Disconnect");
    await act(async () => button().click());
    expect(wallet.value.disconnect).toHaveBeenCalledTimes(1);
    expect(wallet.value.connect).not.toHaveBeenCalled();
  });

  it("a wallet remembered from an earlier visit loads the providers on load (it reconnects itself), without opening the picker", async () => {
    window.localStorage.setItem(REMEMBERED_WALLET_KEY, JSON.stringify("Phantom"));
    wallet.value = connection({ address: ADDRESS, connected: true });
    await act(async () => root.render(page()));
    expect(wallet.providerMounts).toBe(1);
    expect(button().getAttribute("data-connected")).toBe("true");
    expect(wallet.value.connect).not.toHaveBeenCalled();
  });

  it("Buy opens in the same providers tree as Connect wallet, so it uses the wallet connected in the header", async () => {
    wallet.value = connection({ address: ADDRESS, connected: true });
    const stocks = { snapshotAt: "2026-11-10T03:00:00.000Z", gainers: [{ underlying: "TSLA", company: "Tesla", priceUsd: 375, change24hPct: 4, icon: null }], stocks: [], buy: { TSLA: tesla } };
    await act(async () => root.render(createElement("div", null, page(), createElement(StockCards, { stocks: stocks as never }))));
    await act(async () => button().click());
    await act(async () => host.querySelector<HTMLButtonElement>("[data-testid=stock-buy-TSLA]")!.click());
    expect(host.querySelector("[data-testid=buy-modal]")!.textContent).toBe("Buy Tesla");
    expect(wallet.providerMounts).toBe(1);
    // Already connected: the click did not open the picker again.
    expect(wallet.value.connect).not.toHaveBeenCalled();
    await act(async () => homepageWallet.closeBuy());
    expect(host.querySelector("[data-testid=buy-modal]")).toBeNull();
    // The root stays mounted after the modal closes (the purchase notice lives there).
    expect(wallet.providerMounts).toBe(1);
  });
});

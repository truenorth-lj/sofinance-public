// @vitest-environment happy-dom
import { act, createElement, type FunctionComponent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectedApp } from "./selected-app";
import { WalletConnectionContext, type WalletConnection } from "./wallet-connection";
import fixture from "./__fixtures__/position-performance-sample.json";
import { USDC_MINT } from "@sofinance/engine/ids";

vi.mock("./use-sol-usdc-price", () => ({ useSolUsdcPrices: () => ({ rate: null, usdcUsd: null }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/app/portfolio" }));
vi.mock("./use-token-metadata", () => ({ useTokenMetadata: () => ({}) }));
vi.mock("./use-compound-controller", () => ({ useCompoundController: () => ({
  wallet: undefined, state: null, preview: null, attempt: null, stage: "idle", busy: false, canCompound: false, loading: false,
  compound: vi.fn(), refreshState: vi.fn(), receipts: [], priorReceipts: [], error: "", cleanupBatch: undefined, cleanup: undefined, positionMint: "" }) }));
vi.mock("./transaction-status-dialog", () => ({ TransactionStatusDialog: () => null }));
vi.mock("./pool-daily-apr-panel", () => ({ PoolDailyAprChart: () => null }));

const OWN_WALLET = "22222222222222222222222222222222";
const OTHER_WALLET = "44444444444444444444444444444444";
const NFT_ATA = "33333333333333333333333333333333";
const MINT_A = "MintA111111111111111111111111111111111111";
const MINT_B = "MintB111111111111111111111111111111111111";

const position = (positionMint: string, symbolB: string) => ({ positionMint, positionAccount: "p", poolId: "pool", mintA: fixture.mintA, mintB: fixture.mintB,
  symbolA: "USDC", symbolB, decimalsA: 6, decimalsB: 8, feeTierBps: 1, tickLower: -10, tickUpper: 10, tickCurrent: 0,
  rangeSide: "inside", liquidity: "1" });
const discovery = (wallet: string, mints: { mint: string; symbol: string }[]) => ({
  wallet, slot: 1, fetchedAt: 1, positions: mints.map((item) => position(item.mint, item.symbol)),
  assets: [{ kind: "token", mint: USDC_MINT, tokenProgram: null, decimals: 6, balance: "1000000", totalBalance: "1000000", account: NFT_ATA, eligible: true, reason: null }],
});

let container: HTMLDivElement; let root: Root;
let walletScan: { ok: boolean; wallet?: string };
const flush = async (ms = 50) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const settle = async () => { for (let i = 0; i < 20; i++) await flush(100); };
const rowKeys = () => [...container.querySelectorAll("[data-testid=position-row]")].map((el) => el.getAttribute("data-row-key"));

function mount(address: string) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("/api/wallet?")) {
      if (!walletScan.ok) return Response.json({ error: "Wallet scan failed" }, { status: 503 });
      return Response.json(discovery(walletScan.wallet ?? address, [{ mint: MINT_A, symbol: "SPCX" }, { mint: MINT_B, symbol: "INTC" }]));
    }
    if (url.startsWith("/api/selected-state?")) return Response.json({ error: "Selected position reading failed" }, { status: 500 });
    if (url === "/api/portfolio") {
      return Response.json({ wallet: address, positions: [
        { key: `raydium-clmm:${MINT_A}`, status: "ready", figures: { stock: "SPCX", shares: 1, valueUsd: 100, unclaimedFeesUsd: 0, cumulativeFeesUsd: 11.36 },
          evaluatedAt: "2026-11-21T00:00:00Z", historyComplete: true, historyRefreshResolved: true, historyStatus: "fresh" },
        { key: `raydium-clmm:${MINT_B}`, status: "ready", figures: { stock: "INTC", shares: 1, valueUsd: 80, unclaimedFeesUsd: 0, cumulativeFeesUsd: 2.1 },
          evaluatedAt: "2026-11-21T00:00:00Z", historyComplete: true, historyRefreshResolved: true, historyStatus: "fresh" },
      ] });
    }
    return Response.json({});
  }));
  const connection: WalletConnection = { address, connected: true, connect: vi.fn(), disconnect: vi.fn(), isMobile: false,
    walletsCount: 1, connectionError: "", signTransaction: async (tx) => tx };
  return act(async () => root.render(createElement(WalletConnectionContext.Provider, { value: connection },
    createElement(SelectedApp as unknown as FunctionComponent<object>, {}))));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  walletScan = { ok: true, wallet: OWN_WALLET };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Raydium discovery resilience", () => {
  it("keeps the last successful position list when a later wallet scan fails, and shows a visible notice", async () => {
    await mount(OWN_WALLET); await settle();
    expect(rowKeys()).toEqual([`raydium-clmm:${MINT_A}`, `raydium-clmm:${MINT_B}`]);
    expect(container.querySelector("[data-testid=raydium-positions-error]")).toBeNull();
    walletScan.ok = false;
    const refresh = [...container.querySelectorAll("button")].find((button) => button.textContent === "Refresh")!;
    await act(async () => refresh.click()); await settle();
    expect(rowKeys()).toEqual([`raydium-clmm:${MINT_A}`, `raydium-clmm:${MINT_B}`]);
    expect(container.querySelector("[data-testid=raydium-positions-error]")!.textContent)
      .toBe("Couldn't refresh positions. Showing the last list.");
  });

  it("shows a load error and no rows when the first scan fails, and does not keep another wallet's list after a switch", async () => {
    await mount(OWN_WALLET); await settle();
    expect(rowKeys()).toHaveLength(2);
    walletScan.ok = false;
    walletScan.wallet = OTHER_WALLET;
    await mount(OTHER_WALLET); await settle();
    expect(rowKeys()).toEqual([]);
    expect(container.querySelector("[data-testid=raydium-positions-error]")!.textContent)
      .toBe("Couldn't load positions. Refresh to retry.");
    expect(container.textContent).not.toContain("Loading positions…");
  });
});

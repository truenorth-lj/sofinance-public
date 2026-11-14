// @vitest-environment happy-dom
// Performance tab inside SelectedApp: deep links, the exit estimate never waiting forever, unclaimed fees next to liquidity.
import { act, createElement, type FunctionComponent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectedApp } from "./selected-app";
import { WalletConnectionContext, type WalletConnection } from "./wallet-connection";
import fixture from "./__fixtures__/position-performance-sample.json";
import { USDC_MINT } from "@sofinance/engine/ids";

vi.mock("./use-sol-usdc-price", () => ({ useSolUsdcPrices: () => ({ rate: null, usdcUsd: null }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/app" }));
vi.mock("./use-token-metadata", () => ({ useTokenMetadata: () => ({}) }));
const compoundMock = vi.hoisted(() => ({ state: null as unknown, busy: false }));
vi.mock("./use-compound-controller", () => ({ useCompoundController: () => ({
  wallet: undefined, state: compoundMock.state, preview: null, attempt: null, stage: "idle", busy: compoundMock.busy, canCompound: false,
  compound: vi.fn(), receipts: [], priorReceipts: [], error: "" }) }));
vi.mock("./transaction-status-dialog", () => ({ TransactionStatusDialog: () => null }));
vi.mock("./pool-daily-apr-panel", () => ({ PoolDailyAprChart: () => null }));

const DEEP_LINK_MINT = "DeepLink1111111111111111111111111111111111";
const OWNED_MINT = fixture.positionMint;
const OTHER_OWNED_MINT = "AnotherPos111111111111111111111111111111111";
const OWN_WALLET = "22222222222222222222222222222222";
const NFT_ATA = "33333333333333333333333333333333";
const exitBody = { status: "verified-preview", executable: false, sent: false, recoveryUSDCAtomic: "1000000",
  recoverySOLLamports: "8580200", localExpiresAt: "2999-01-01T00:00:00.000Z" };
const position = (positionMint: string) => ({ positionMint, positionAccount: "p", poolId: fixture.poolId, mintA: fixture.mintA, mintB: fixture.mintB,
  symbolA: "SPCXx", symbolB: "SPCX", decimalsA: 8, decimalsB: 8, feeTierBps: 1, tickLower: -10, tickUpper: 10, tickCurrent: 0,
  rangeSide: "inside", liquidity: "1" });
const discovery = (mints: string[]) => ({ wallet: OWN_WALLET, slot: 1, fetchedAt: 1, positions: mints.map(position),
  assets: [{ kind: "token", mint: USDC_MINT, tokenProgram: null, decimals: 6, balance: "1000000", totalBalance: "1000000", account: NFT_ATA, eligible: true, reason: null }] });
const selectedState = (positionMint: string) => ({ wallet: OWN_WALLET, slot: 1, fetchedAt: Date.now(), positionMint, positionAccount: "p", poolId: fixture.poolId,
  programId: "x", inputKind: "token", inputMint: USDC_MINT, inputDecimals: 6, inputTokenProgram: null, inputAccount: NFT_ATA, inputBalance: "1000000",
  mintA: fixture.mintA, mintB: fixture.mintB, decimalsA: 8, decimalsB: 8, programA: "x", programB: "x", nftProgram: "x",
  ataA: "a", ataB: "b", nftAta: NFT_ATA, balances: { a: "0", b: "0", input: "1000000" }, sqrtPriceX64: "1", tickCurrent: 0, tickLower: -10, tickUpper: 10,
  lowerSqrtX64: "1", upperSqrtX64: "2", price: "1", inRange: true, rangeSide: "inside", liquidity: "1", poolLiquidity: "1",
  currentAmounts: { a: "500000000", b: "520000000" }, ownsNft: true, paused: false, transferFee: false, frozen: false, unsupportedExtensions: [],
  solLamports: 1_000_000_000, sufficientSol: true, pricing: { priceUsdA: 100, priceUsdB: 50 } });

const stockFixture = {
  symbol: "SPCX", priceMint: fixture.mintA, priceUsd: 100, change24hPct: 1,
  sharesNow: 2, valueUsd: 200, sharesIn: null, firstDepositAtIso: null,
  entryPriceUsd: null, priceChangeUsd: null, priceChangePct: null,
  feeShares: 0.01, feeUsd: 1, totalUsd: null, sparkline24h: [], sparklineSinceEntry: [],
  entryPriceSource: null, entryUnavailableReason: "Entry price unavailable.",
};
type Mode = { wallet: string | null; positions: string[]; stateOk: boolean; initialMint: string; stock?: boolean; performanceFail?: boolean; initialView?: "performance" | "compound" | "deposit" | "withdraw" };
let container: HTMLDivElement; let root: Root;
let calls: string[];
const count = (prefix: string) => calls.filter((u) => u.startsWith(prefix)).length;
const flush = async (ms = 50) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const settle = async () => { for (let i = 0; i < 20; i++) await flush(100); };
const param = (url: string, name: string) => new URL(url, "http://x").searchParams.get(name);

function mount(mode: Mode) {
  const connected = mode.wallet !== null;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input); calls.push(url);
    if (url.startsWith("/api/wallet?")) return Response.json(discovery(mode.positions));
    if (url.startsWith("/api/selected-state?")) {
      return mode.stateOk ? Response.json(selectedState(param(url, "positionMint")!))
        : Response.json({ error: "Selected position reading failed" }, { status: 500 });
    }
    if (url.startsWith("/api/position-performance?") && mode.performanceFail) return Response.json({ error: "Performance unavailable" }, { status: 503 });
    if (url.startsWith("/api/position-performance?")) return Response.json({ ...fixture, positionMint: param(url, "positionMint"), ...(mode.stock ? { stock: stockFixture } : {}) });
    if (url.startsWith("/api/lp-decision/exit-preview?")) return Response.json(exitBody);
    return Response.json({});
  }));
  const connection: WalletConnection = { address: mode.wallet ?? "", connected, connect: vi.fn(), disconnect: vi.fn(), isMobile: false,
    walletsCount: 1, connectionError: "", signTransaction: async (tx) => tx };
  return act(async () => root.render(createElement(WalletConnectionContext.Provider, { value: connection },
    createElement(SelectedApp as unknown as FunctionComponent<{ initialView: string; initialMint: string }>, { initialView: mode.initialView ?? "performance", initialMint: mode.initialMint }))));
}
const exitSection = () => container.querySelector('[aria-label="Exit estimates"]');
const exitUrls = () => calls.filter((u) => u.startsWith("/api/lp-decision/exit-preview?"));
const perfMints = () => calls.filter((u) => u.startsWith("/api/position-performance?")).map((u) => param(u, "positionMint"));
const manualPreview = () => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Preview exit: USDC + SOL"));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  calls = [];
  compoundMock.state = null; compoundMock.busy = false;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("the exit estimate lives in the Withdraw tool, not in Performance", () => {
  it("no wallet connected: a Performance deep link reads performance and no exit estimate", async () => {
    await mount({ wallet: null, positions: [], stateOk: true, initialMint: DEEP_LINK_MINT });
    await settle();
    expect(perfMints()).toEqual([DEEP_LINK_MINT]);
    expect(exitSection()).toBeNull();
    expect(manualPreview()).toBeUndefined();
    expect(count("/api/lp-decision/exit-preview")).toBe(0);
  });

  it("wallet connected but it holds no positions: the deep link still shows Performance, no exit estimate", async () => {
    await mount({ wallet: OWN_WALLET, positions: [], stateOk: true, initialMint: DEEP_LINK_MINT });
    await settle();
    expect(perfMints()).toEqual([DEEP_LINK_MINT]);
    expect(container.querySelector("#performance-view")).not.toBeNull();
    expect(exitSection()).toBeNull();
    expect(count("/api/lp-decision/exit-preview")).toBe(0);
  });

  it("deep link to a position held by someone else: the link wins over the wallet's own first position", async () => {
    await mount({ wallet: OWN_WALLET, positions: [OWNED_MINT], stateOk: true, initialMint: DEEP_LINK_MINT });
    await settle();
    // The single owned position now belongs to the overview too; the linked report remains first and is not re-read.
    expect(perfMints()).toEqual([DEEP_LINK_MINT, OWNED_MINT]);
    expect(container.textContent).toContain("Showing the linked position Deep…1111");
    expect(exitSection()).toBeNull();
    expect(count("/api/lp-decision/exit-preview")).toBe(0);
  });

  it("Withdraw on a held position with ready state runs exactly one exit estimate using the wallet's NFT account", async () => {
    await mount({ wallet: OWN_WALLET, positions: [OWNED_MINT], stateOk: true, initialMint: OWNED_MINT, initialView: "withdraw" });
    await settle();
    expect(exitUrls().map((u) => [param(u, "positionId"), param(u, "nftAccount")])).toEqual([[OWNED_MINT, NFT_ATA]]);
    expect(container.querySelector("#withdraw-view")?.contains(exitSection())).toBe(true);
    expect(exitSection()?.textContent).toContain("1.000000 USDC + 0.008580200 SOL");
    expect(manualPreview()).toBeUndefined();
    expect(perfMints()).toEqual([]);
  });

  it("Withdraw: choosing another position moves the exit estimate to it", async () => {
    await mount({ wallet: OWN_WALLET, positions: [OTHER_OWNED_MINT, OWNED_MINT], stateOk: true, initialMint: OWNED_MINT, initialView: "withdraw" });
    await settle();
    expect(exitUrls().map((u) => param(u, "positionId"))).toEqual([OWNED_MINT]);
    const pick = container.querySelector<HTMLButtonElement>(`[data-testid="position-fallback-select"][data-position-key="raydium-clmm:${OTHER_OWNED_MINT}"]`)!;
    await act(async () => pick.click());
    await settle();
    expect(exitUrls().map((u) => param(u, "positionId")).at(-1)).toBe(OTHER_OWNED_MINT);
  });

  it("Withdraw while the position state cannot be read: no estimate and no exit-preview read (never spins)", async () => {
    await mount({ wallet: OWN_WALLET, positions: [OWNED_MINT], stateOk: false, initialMint: OWNED_MINT, initialView: "withdraw" });
    await settle();
    expect(container.textContent).not.toContain("Waiting for position accounts…");
    expect(exitSection()).toBeNull();
    expect(count("/api/lp-decision/exit-preview")).toBe(0);
  });
});

describe("stock summary and position detail hierarchy", () => {
  it("keeps the one empty state and the page's Refresh control", async () => {
    await mount({ wallet: OWN_WALLET, positions: [], stateOk: true, initialMint: "" });
    await settle();
    const entry = container.querySelector('[aria-labelledby="all-positions-heading"]')!;
    expect(entry.querySelector('[data-testid="positions-empty-state"]')?.textContent).toContain("No positions in this wallet yet.");
    expect(entry.textContent).not.toContain("No identifiable position found");
    const rescan = [...container.querySelectorAll("button")].find((button) => button.textContent === "Refresh")!;
    const before = count("/api/wallet?");
    await act(async () => rescan.click()); await settle();
    expect(count("/api/wallet?")).toBe(before + 1);
  });
  it("keeps all positions selectable when every performance read fails", async () => {
    await flush(60_001);
    await mount({ wallet: OWN_WALLET, positions: [OWNED_MINT, OTHER_OWNED_MINT], stateOk: true, initialMint: OWNED_MINT, performanceFail: true });
    await settle();
    const rows = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="position-fallback-select"]')];
    expect(rows.map((row) => row.getAttribute("data-position-key")).sort()).toEqual([OWNED_MINT, OTHER_OWNED_MINT].map((mint) => `raydium-clmm:${mint}`).sort());
    expect(container.textContent).toContain("2 positions could not be read");
    await act(async () => rows.find((row) => row.getAttribute("data-position-key") === `raydium-clmm:${OTHER_OWNED_MINT}`)!.click());
    await settle();
    expect(perfMints().at(-1)).toBe(OTHER_OWNED_MINT);
  });
  it("Compound fees keeps All positions (no dropdown of its own); its rows lock during a compound", async () => {
    compoundMock.busy = true;
    await mount({ wallet: OWN_WALLET, positions: [OWNED_MINT, OTHER_OWNED_MINT], stateOk: true, initialMint: OWNED_MINT, initialView: "compound" });
    await settle();
    const entry = container.querySelector('[aria-labelledby="all-positions-heading"]')!;
    const rows = [...entry.querySelectorAll<HTMLButtonElement>('[data-testid="position-fallback-select"]')];
    expect(rows.map((row) => row.getAttribute("data-position-key")).sort()).toEqual([`raydium-clmm:${OWNED_MINT}`, `raydium-clmm:${OTHER_OWNED_MINT}`].sort());
    expect(rows.find((row) => row.getAttribute("aria-pressed") === "true")?.getAttribute("data-position-key")).toBe(`raydium-clmm:${OWNED_MINT}`);
    expect(rows.every((row) => row.disabled)).toBe(true);
    expect(container.querySelector("#compound-position")).toBeNull();
    // The tabs sit inside the selected position's detail, the tool below the list.
    expect(entry.querySelector('[data-testid="selected-position-detail"] nav[aria-label="Position operations"]')).not.toBeNull();
    expect(container.querySelector('#compound-view')).not.toBeNull();
  });
  it("uses lightweight rows outside Performance without reading any history", async () => {
    await mount({ wallet: OWN_WALLET, positions: [OWNED_MINT, OTHER_OWNED_MINT], stateOk: true, initialMint: OWNED_MINT, initialView: "deposit" });
    await settle();
    expect(perfMints()).toEqual([]);
    expect(container.querySelectorAll('[data-testid="position-fallback-select"]')).toHaveLength(2);
    expect(container.querySelector('[data-testid="stocks-overview"]')).toBeNull();
    const pick = container.querySelector<HTMLButtonElement>(`[data-position-key="raydium-clmm:${OTHER_OWNED_MINT}"]`)!;
    await act(async () => pick.click()); await settle();
    expect(perfMints()).toEqual([]);
    expect(container.querySelector('[data-testid="position-assets-collapse"]')?.getAttribute("data-open")).toBe("true");
    expect(new URL(window.location.href).searchParams.get("position")).toBe(`raydium-clmm:${OTHER_OWNED_MINT}`);
  });
  it("shows stock cards only in the overview, retaining details for the selected position", async () => {
    await mount({ wallet: OWN_WALLET, positions: [OTHER_OWNED_MINT, OWNED_MINT], stateOk: true, initialMint: OWNED_MINT, stock: true });
    await settle();
    expect(container.querySelector('[data-testid="stocks-overview"]')).not.toBeNull();
    expect(container.querySelector('#performance-view [data-testid="stock-performance"]')).toBeNull();
    expect(container.querySelector('#performance-view')?.textContent).toContain("Position details");
    // Range and the per-token rows are shown once, above the tabs: not repeated in Performance.
    expect(container.querySelector('#performance-view')?.textContent).not.toContain("In range");
    expect(container.querySelector('[data-testid="position-assets-collapse"]')?.getAttribute("data-open")).toBe("false");
  });
  it("selects a position from the stock drilldown and updates the existing position details", async () => {
    // Expire overview fixtures cached by earlier cases that had no stock report.
    await flush(60_001);
    await mount({ wallet: OWN_WALLET, positions: [OTHER_OWNED_MINT, OWNED_MINT], stateOk: true, initialMint: OWNED_MINT, stock: true });
    await settle();
    const rowToggle = container.querySelector('[data-testid="stock-row"] button') as HTMLButtonElement;
    await act(async () => rowToggle.click());
    const pick = container.querySelector(`[data-testid="stock-position-select"][data-position-key="raydium-clmm:${OTHER_OWNED_MINT}"]`) as HTMLButtonElement;
    expect(pick).not.toBeNull();
    await act(async () => pick.click());
    await settle();
    expect(perfMints().at(-1)).toBe(OTHER_OWNED_MINT);
    expect(container.querySelector('#performance-view [data-testid="position-detail-identity"]')?.textContent).toContain(OTHER_OWNED_MINT);
    expect(container.querySelector('#performance-view [data-testid="stock-performance"]')).toBeNull();
  });
  it("uses All positions as the only entry, including a single stock drilldown", async () => {
    await mount({ wallet: OWN_WALLET, positions: [OWNED_MINT], stateOk: true, initialMint: OWNED_MINT, stock: true });
    await settle();
    const entry = container.querySelector('section[aria-labelledby="all-positions-heading"]')!;
    expect(entry).not.toBeNull();
    expect(container.textContent).not.toContain("My positions");
    expect(container.querySelector('select#position')).toBeNull();
    expect(entry.querySelector('[data-testid="stocks-overview"]')).not.toBeNull();
    expect(entry.querySelectorAll('[data-testid="position-fallback-select"]')).toHaveLength(0);
    expect(entry.querySelectorAll('[data-testid="stock-position-select"]')).toHaveLength(1);
    expect(container.querySelector('#performance-view [data-testid="stock-performance"]')).toBeNull();
  });
  it("keeps a foreign linked position's cards when that position is not represented in the overview", async () => {
    await mount({ wallet: OWN_WALLET, positions: [OWNED_MINT, OTHER_OWNED_MINT], stateOk: true, initialMint: DEEP_LINK_MINT, stock: true });
    await settle();
    expect(container.querySelector('#performance-view [data-testid="stock-performance"]')).not.toBeNull();
  });
});

describe("position asset rows: liquidity and unclaimed fees side by side", () => {
  const rows = () => container.querySelector('[aria-label="Position assets"]')!.textContent!;
  it("shows liquidity and unclaimed fees per token (amounts and USD) so they add up to the position value", async () => {
    compoundMock.state = { ...selectedState(OWNED_MINT), eligible: true, reason: null, status: 0, vaultA: "v", vaultB: "w", tickSpacing: 1,
      fees: { a: "25000000", b: "10000000" }, rewards: [] };
    await mount({ wallet: OWN_WALLET, positions: [OWNED_MINT], stateOk: true, initialMint: OWNED_MINT });
    await settle();
    const text = rows();
    expect(text.match(/Liquidity/g)).toHaveLength(2);
    expect(text.match(/Unclaimed fees/g)).toHaveLength(2);
    // A: 5 SPCXx liquidity ($500) + 0.25 unclaimed ($25); B: 5.2 SPCX liquidity ($260) + 0.1 unclaimed ($5) = $790 in total.
    for (const expected of ["Liquidity5", "$500.00", "Unclaimed fees0.25 ", "$25.00", "Liquidity5.2", "$260.00", "Unclaimed fees0.1 ", "$5.00"]) expect(text).toContain(expected);
    expect(500 + 25 + 260 + 5).toBe(790);
  });
  it("shows a dash, never zero, while unclaimed fees are not available", async () => {
    await mount({ wallet: OWN_WALLET, positions: [OWNED_MINT], stateOk: true, initialMint: OWNED_MINT });
    await settle();
    expect(rows()).toContain("Unclaimed fees— ");
    expect(rows()).not.toContain("Unclaimed fees0 ");
  });
});

describe("leaving and re-entering the Performance tab", () => {
  const tab = (label: string) => [...container.querySelectorAll('nav[aria-label="Position operations"] button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
  it("currently re-requests performance data on every visit (no reuse) and never reads the exit estimate there", async () => {
    await mount({ wallet: OWN_WALLET, positions: [OWNED_MINT], stateOk: true, initialMint: OWNED_MINT });
    await settle();
    const exitAfterVisit = [count("/api/lp-decision/exit-preview")];
    const perfAfterVisit = [count("/api/position-performance")];
    for (let i = 0; i < 3; i++) {
      await act(async () => tab("Add to position").click()); await flush(100);
      await act(async () => tab("Performance").click()); await settle();
      exitAfterVisit.push(count("/api/lp-decision/exit-preview"));
      perfAfterVisit.push(count("/api/position-performance"));
    }
    expect(exitAfterVisit).toEqual([0, 0, 0, 0]);
    expect(perfAfterVisit).toEqual([1, 2, 3, 4]);
  });
});

// @vitest-environment happy-dom
// Performance tab inside SelectedApp: deep links, the exit estimate never waiting forever, unclaimed fees next to liquidity.
import { act, createElement, type FunctionComponent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectedApp } from "./selected-app";
import { openPopup, openRowDetail, openRowTool, rowAction } from "./test-support/portfolio-popups";
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
const own = `raydium-clmm:${OWNED_MINT}`; const other = `raydium-clmm:${OTHER_OWNED_MINT}`;
const closeOpenPopup = async () => {
  const close = container.querySelector<HTMLButtonElement>('dialog[data-open="true"] button[aria-label="Close"]');
  if (close) await act(async () => close.click());
};
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
    expect(perfMints()).toEqual([DEEP_LINK_MINT]);
    expect(calls).toContain("/api/portfolio");
    expect(container.textContent).toContain("Showing the linked position Deep…1111");
    expect(exitSection()).toBeNull();
    expect(count("/api/lp-decision/exit-preview")).toBe(0);
  });

  it("Withdraw on a held position with ready state runs exactly one exit estimate using the wallet's NFT account", async () => {
    await mount({ wallet: OWN_WALLET, positions: [OWNED_MINT], stateOk: true, initialMint: OWNED_MINT, initialView: "withdraw" });
    await settle();
    expect(exitUrls()).toEqual([]); // an old view=withdraw link opens nothing
    await openRowTool(container, "withdraw", own); await settle();
    expect(exitUrls().map((u) => [param(u, "positionId"), param(u, "nftAccount")])).toEqual([[OWNED_MINT, NFT_ATA]]);
    expect(container.querySelector("#withdraw-view")?.contains(exitSection())).toBe(true);
    expect(exitSection()?.textContent).toContain("1.000000 USDC + 0.008580200 SOL");
    expect(manualPreview()).toBeUndefined();
    expect(perfMints().every((mint) => mint === OWNED_MINT)).toBe(true); // only the row's own value read
  });

  it("Withdraw: choosing another position moves the exit estimate to it", async () => {
    await mount({ wallet: OWN_WALLET, positions: [OTHER_OWNED_MINT, OWNED_MINT], stateOk: true, initialMint: OWNED_MINT, initialView: "withdraw" });
    await settle();
    await openRowTool(container, "withdraw", own); await settle();
    expect(exitUrls().map((u) => param(u, "positionId"))).toEqual([OWNED_MINT]);
    await closeOpenPopup();
    await openRowTool(container, "withdraw", other); await settle();
    expect(exitUrls().map((u) => param(u, "positionId")).at(-1)).toBe(OTHER_OWNED_MINT);
  });

  it("Withdraw while the position state cannot be read: no estimate and no exit-preview read (never spins)", async () => {
    await mount({ wallet: OWN_WALLET, positions: [OWNED_MINT], stateOk: false, initialMint: OWNED_MINT, initialView: "withdraw" });
    await settle();
    await openRowTool(container, "withdraw", own); await settle();
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
    expect(container.textContent).toContain("Some values are unavailable for 2 positions");
    await act(async () => rows.find((row) => row.getAttribute("data-position-key") === `raydium-clmm:${OTHER_OWNED_MINT}`)!.click());
    await settle();
    expect(perfMints().at(-1)).toBe(OTHER_OWNED_MINT);
  });
  it("an old view=compound link lands on Portfolio with nothing open; other rows' operations lock during a compound", async () => {
    compoundMock.busy = true;
    await mount({ wallet: OWN_WALLET, positions: [OWNED_MINT, OTHER_OWNED_MINT], stateOk: true, initialMint: OWNED_MINT, initialView: "compound" });
    await settle();
    const entry = container.querySelector('[aria-labelledby="all-positions-heading"]')!;
    const rows = [...entry.querySelectorAll<HTMLButtonElement>('[data-testid="position-fallback-select"]')];
    expect(rows.map((row) => row.getAttribute("data-position-key")).sort()).toEqual([own, other].sort());
    expect(rows.some((row) => row.hasAttribute("aria-pressed"))).toBe(false);
    expect(container.querySelector('dialog[data-open="true"]')).toBeNull();
    expect(container.querySelector("#compound-view")).toBeNull();
    expect(container.querySelector("#deposit-view")).toBeNull();
    expect(entry.querySelector('nav[aria-label="Position operations"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="position-row-action"][data-tool="compound"]')).toHaveLength(2);
    for (const key of [own, other]) for (const tool of ["deposit", "withdraw"] as const) expect(rowAction(container, tool, key)?.disabled).toBe(true);
    expect(calls.filter((u) => u.includes("-prepare"))).toEqual([]);
  });
  it("lists every position with no tool open; clicking a row opens its Performance detail", async () => {
    await mount({ wallet: OWN_WALLET, positions: [OWNED_MINT, OTHER_OWNED_MINT], stateOk: true, initialMint: OWNED_MINT, initialView: "deposit" });
    await settle();
    expect(container.querySelectorAll('[data-testid="position-fallback-select"]')).toHaveLength(2);
    expect(container.querySelector('dialog[data-open="true"]')).toBeNull();
    await openRowDetail(container, other); await settle();
    const popup = openPopup(container, "performance-popup")!;
    expect(popup.querySelector("#performance-view")).not.toBeNull();
    expect(perfMints().at(-1)).toBe(OTHER_OWNED_MINT);
    expect(container.querySelector('[data-testid="position-assets-collapse"]')).toBeNull();
    const url = new URL(window.location.href).searchParams;
    expect([url.get("position"), url.get("view")]).toEqual([other, "performance"]);
  });
  it("has no stock overview on Portfolio; the detail shows the price change vs fee income split without repeating the row", async () => {
    await mount({ wallet: OWN_WALLET, positions: [OTHER_OWNED_MINT, OWNED_MINT], stateOk: true, initialMint: OWNED_MINT, stock: true });
    await settle();
    const entry = container.querySelector('section[aria-labelledby="all-positions-heading"]')!;
    // LJ 11/15: nothing above or below the rows; the stock, shares, value and fees are the rows' own columns.
    expect(container.querySelector('[data-testid="stocks-overview"]')).toBeNull();
    expect([...container.querySelectorAll('[data-testid="stock-performance"]')].filter((el) => !el.closest("dialog"))).toEqual([]);
    expect(entry.querySelectorAll('[data-testid="position-fallback-select"]')).toHaveLength(2);
    expect(container.textContent).not.toContain("My positions");
    expect(container.querySelector('select#position')).toBeNull();
    const stock = openPopup(container, "performance-popup")!.querySelector('#performance-view [data-testid="stock-performance"]')!;
    expect(stock).not.toBeNull();
    for (const tile of ["stock-tile-price", "stock-tile-shares", "stock-tile-fees"]) expect(stock.querySelector(`[data-testid="${tile}"]`)).not.toBeNull();
    expect(stock.textContent).not.toContain("Position value");
    // No range badge or per-token rows in the details (the position's row shows them).
    expect(container.querySelector('#performance-view')?.textContent).not.toContain("In range");
    expect(container.querySelector('[data-testid="position-assets-collapse"]')).toBeNull();
  });
  it("keeps a foreign linked position's price change vs fee income split", async () => {
    await mount({ wallet: OWN_WALLET, positions: [OWNED_MINT, OTHER_OWNED_MINT], stateOk: true, initialMint: DEEP_LINK_MINT, stock: true });
    await settle();
    expect(container.querySelector('#performance-view [data-testid="stock-performance"]')).not.toBeNull();
  });
});

describe("the Performance detail popup (LJ 11/14)", () => {
  it("has no tabs, Learn more details or duplicate range and fee rows; the row's detail holds the performance panel", async () => {
    compoundMock.state = { ...selectedState(OWNED_MINT), eligible: true, reason: null, status: 0, vaultA: "v", vaultB: "w", tickSpacing: 1,
      fees: { a: "25000000", b: "10000000" }, rewards: [] };
    await mount({ wallet: OWN_WALLET, positions: [OWNED_MINT], stateOk: true, initialMint: OWNED_MINT });
    await settle();
    expect(container.querySelector('[data-testid="selected-position-detail"]')).toBeNull();
    expect(container.querySelector('nav[aria-label="Position operations"]')).toBeNull();
    expect(container.textContent).not.toContain("Learn more details");
    // view=performance (the default here) opened this position's detail.
    const detail = openPopup(container, "performance-popup")!;
    expect(detail).not.toBeNull();
    expect(container.querySelector('[aria-label="Position assets"]')).toBeNull();
    expect(detail.querySelector('[data-testid="range-badge"]')).toBeNull();
    expect(detail.textContent).not.toMatch(/Unclaimed fees/);
  });
  it("re-reads performance on every open and never reads the exit estimate there", async () => {
    await mount({ wallet: OWN_WALLET, positions: [OWNED_MINT], stateOk: true, initialMint: OWNED_MINT });
    await settle();
    const exitAfterVisit = [count("/api/lp-decision/exit-preview")];
    const perfAfterVisit = [count("/api/position-performance")];
    for (let i = 0; i < 3; i++) {
      await closeOpenPopup(); await flush(100);
      await openRowDetail(container, own); await settle();
      exitAfterVisit.push(count("/api/lp-decision/exit-preview"));
      perfAfterVisit.push(count("/api/position-performance"));
    }
    expect(exitAfterVisit).toEqual([0, 0, 0, 0]);
    expect(perfAfterVisit.slice(1).map((n, i) => n - perfAfterVisit[i]!)).toEqual([1, 1, 1]);
  });
});

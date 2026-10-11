// @vitest-environment happy-dom
// Performance tab inside SelectedApp: deep links, the exit estimate never waiting forever, unclaimed fees next to liquidity.
import { act, createElement, type FunctionComponent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectedApp } from "./selected-app";
import { WalletConnectionContext, type WalletConnection } from "./wallet-connection";
import fixture from "./__fixtures__/position-performance-sample.json";
import { USDC_MINT } from "@/lib/ids";

vi.mock("./use-sol-usdc-price", () => ({ useSolUsdcPrices: () => ({ rate: null, usdcUsd: null }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/app" }));
vi.mock("./use-token-metadata", () => ({ useTokenMetadata: () => ({}) }));
const compoundMock = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("./use-compound-controller", () => ({ useCompoundController: () => ({
  wallet: undefined, state: compoundMock.state, preview: null, attempt: null, stage: "idle", busy: false, canCompound: false,
  compound: vi.fn(), receipts: [], priorReceipts: [], error: "" }) }));
vi.mock("./transaction-status-dialog", () => ({ TransactionStatusDialog: () => null }));
vi.mock("./pool-activity-panel", () => ({ PoolActivityPanel: () => null }));
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

type Mode = { wallet: string | null; positions: string[]; stateOk: boolean; initialMint: string };
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
    if (url.startsWith("/api/position-performance?")) return Response.json({ ...fixture, positionMint: param(url, "positionMint") });
    if (url.startsWith("/api/lp-decision/exit-preview?")) return Response.json(exitBody);
    return Response.json({});
  }));
  const connection: WalletConnection = { address: mode.wallet ?? "", connected, connect: vi.fn(), disconnect: vi.fn(), isMobile: false,
    walletsCount: 1, connectionError: "", signTransaction: async (tx) => tx };
  return act(async () => root.render(createElement(WalletConnectionContext.Provider, { value: connection },
    createElement(SelectedApp as unknown as FunctionComponent<{ initialView: string; initialMint: string }>, { initialView: "performance", initialMint: mode.initialMint }))));
}
const exitSection = () => container.querySelector('[aria-label="Exit estimates"]');
const exitUrls = () => calls.filter((u) => u.startsWith("/api/lp-decision/exit-preview?"));
const perfMints = () => calls.filter((u) => u.startsWith("/api/position-performance?")).map((u) => param(u, "positionMint"));
const manualPreview = () => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Preview exit: USDC + SOL"));
const expectNeverSpins = () => {
  expect(container.textContent).not.toContain("Waiting for position accounts…");
  expect(exitSection()?.textContent).toContain("Connect that wallet, or preview this position manually");
  expect(manualPreview()).toBeDefined();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  calls = [];
  compoundMock.state = null;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Performance deep link /app?view=performance&mint=X: the exit estimate never waits forever", () => {
  it("no wallet connected: explains it and offers a manual preview instead of spinning", async () => {
    await mount({ wallet: null, positions: [], stateOk: true, initialMint: DEEP_LINK_MINT });
    await settle();
    expect(perfMints()).toEqual([DEEP_LINK_MINT]);
    expectNeverSpins();
    expect(count("/api/lp-decision/exit-preview")).toBe(0);
    await act(async () => manualPreview()!.click()); await flush();
    expect(exitUrls()).toHaveLength(1);
    expect(param(exitUrls()[0]!, "positionId")).toBe(DEEP_LINK_MINT);
    expect(param(exitUrls()[0]!, "nftAccount")).toBeNull();
    expect(exitSection()?.textContent).toContain("1.000000 USDC + 0.008580200 SOL");
  });

  it("wallet connected but it holds no positions", async () => {
    await mount({ wallet: OWN_WALLET, positions: [], stateOk: true, initialMint: DEEP_LINK_MINT });
    await settle();
    expect(perfMints()).toEqual([DEEP_LINK_MINT]);
    expectNeverSpins();
    expect(count("/api/lp-decision/exit-preview")).toBe(0);
  });

  it("selected-state fails with HTTP 500 for a position the wallet holds", async () => {
    await mount({ wallet: OWN_WALLET, positions: [OWNED_MINT], stateOk: false, initialMint: OWNED_MINT });
    await settle();
    expect(perfMints()).toEqual([OWNED_MINT]);
    expectNeverSpins();
    expect(count("/api/lp-decision/exit-preview")).toBe(0);
  });

  it("deep link to a position held by someone else: the link wins over the wallet's own first position", async () => {
    await mount({ wallet: OWN_WALLET, positions: [OWNED_MINT], stateOk: true, initialMint: DEEP_LINK_MINT });
    await settle();
    expect(perfMints()).toEqual([DEEP_LINK_MINT]);
    expect(container.textContent).toContain("Showing the linked position Deep…1111");
    expectNeverSpins();
    expect(count("/api/lp-decision/exit-preview")).toBe(0);
    await act(async () => manualPreview()!.click()); await flush();
    expect(exitUrls().map((u) => param(u, "positionId"))).toEqual([DEEP_LINK_MINT]);
    expect(param(exitUrls()[0]!, "nftAccount")).toBeNull();
  });

  it("deep link to one of several positions the wallet holds: exactly one performance read and one exit estimate, for that position", async () => {
    await mount({ wallet: OWN_WALLET, positions: [OTHER_OWNED_MINT, OWNED_MINT], stateOk: true, initialMint: OWNED_MINT });
    await settle();
    expect(perfMints()).toEqual([OWNED_MINT]);
    expect(exitUrls().map((u) => [param(u, "positionId"), param(u, "nftAccount")])).toEqual([[OWNED_MINT, NFT_ATA]]);
    expect(exitSection()?.textContent).toContain("1.000000 USDC + 0.008580200 SOL");
    expect(container.textContent).not.toContain("Showing the linked position");
  });

  it("choosing another position in the selector replaces the deep link", async () => {
    await mount({ wallet: OWN_WALLET, positions: [OTHER_OWNED_MINT, OWNED_MINT], stateOk: true, initialMint: OWNED_MINT });
    await settle();
    const select = [...container.querySelectorAll("select")].find((item) => [...item.options].some((option) => option.value === OTHER_OWNED_MINT))!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, OTHER_OWNED_MINT);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(perfMints().at(-1)).toBe(OTHER_OWNED_MINT);
    expect(exitUrls().map((u) => param(u, "positionId")).at(-1)).toBe(OTHER_OWNED_MINT);
  });

  it("happy path: a held position with ready state runs exactly one exit estimate using the wallet's NFT account", async () => {
    await mount({ wallet: OWN_WALLET, positions: [OWNED_MINT], stateOk: true, initialMint: OWNED_MINT });
    await settle();
    expect(exitUrls().map((u) => [param(u, "positionId"), param(u, "nftAccount")])).toEqual([[OWNED_MINT, NFT_ATA]]);
    expect(exitSection()?.textContent).toContain("1.000000 USDC + 0.008580200 SOL");
    expect(manualPreview()).toBeUndefined();
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
  it("currently re-requests performance data and the exit estimate on every visit (no reuse)", async () => {
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
    expect(exitAfterVisit).toEqual([1, 2, 3, 4]);
    expect(perfAfterVisit).toEqual([1, 2, 3, 4]);
  });
});

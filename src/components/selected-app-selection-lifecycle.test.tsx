// @vitest-environment happy-dom
// Real Add controller + offline discovery: selection and operation targets must agree at every commit.
import { act, createElement, useLayoutEffect, type FunctionComponent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectedApp } from "./selected-app";
import { WalletConnectionContext, type WalletConnection } from "./wallet-connection";
import fixture from "./__fixtures__/position-performance-sample.json";
import { USDC_MINT } from "@sofinance/engine/ids";
import type { SelectedPositionState } from "@sofinance/engine/selected-state";

vi.mock("./use-sol-usdc-price", () => ({ useSolUsdcPrices: () => ({ rate: null, usdcUsd: null }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/app" }));
vi.mock("./use-token-metadata", () => ({ useTokenMetadata: () => ({}) }));
const compoundMock = vi.hoisted(() => ({ state: null as unknown, busy: false }));
vi.mock("./use-compound-controller", () => ({ useCompoundController: (args: { positionMint?: string; externalBlocked: boolean }) => { safety.compoundTarget = args.positionMint ?? ""; safety.blocked = args.externalBlocked; return ({
  wallet: undefined, state: compoundMock.state, preview: null, attempt: null, stage: "idle", busy: compoundMock.busy, canCompound: false,
  compound: vi.fn(), receipts: [], priorReceipts: [], error: "" }); } }));
const safety = vi.hoisted(() => ({ performanceMint: "", staleSnapshot: false, enabled: false, selection: "", compoundTarget: "", blocked: false,
  commits: [] as { selected: string; target: string; compound: string; blocked: boolean; addDisabled: boolean; retry: boolean; withdraw: string }[],
  add: vi.fn(), retry: vi.fn() }));
vi.mock("./use-selected-controller", async (importOriginal) => {
  const original = await importOriginal<typeof import("./use-selected-controller")>();
  return { useSelectedController: () => {
    const real = original.useSelectedController();
    safety.selection = real.selection?.positionMint ?? "";
    // A stale in-flight snapshot must not become a Withdraw target before intent reconciliation.
    const state = safety.staleSnapshot && real.selection
      ? { ...selectedState(real.selection.positionMint), wallet: real.wallet || "" } : real.state;
    return safety.enabled ? { ...real, state, actionDisabled: false, primaryAction: safety.add, retryAdd: safety.retry } : real;
  } };
});
vi.mock("./transaction-status-dialog", () => ({ TransactionStatusDialog: (props: { onRetry?: () => void }) => {
  useLayoutEffect(() => {
    if (!safety.enabled) return;
    const selected = document.querySelector('[data-testid="selected-position-detail"] > p')?.textContent ?? "";
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(b => b.textContent === 'Add liquidity');
    safety.commits.push({ selected, target: safety.selection, compound: safety.compoundTarget,
      blocked: safety.blocked, addDisabled: buttons.length > 0 && buttons.every(b => b.disabled), retry: !!props.onRetry,
      withdraw: document.querySelector('[data-testid="withdraw-target"]')?.textContent ?? "" });
    if (selected.includes('AnotherPos') && safety.selection && !selected.includes(safety.selection)) buttons.forEach(b => b.click());
  });
  return null;
} }));
vi.mock("./position-performance-panel", async (importOriginal) => {
  const original = await importOriginal<typeof import("./position-performance-panel")>();
  return { PositionPerformancePanel: (props: Parameters<typeof original.PositionPerformancePanel>[0]) => {
    safety.performanceMint = props.selectedMint ?? "";
    return createElement(original.PositionPerformancePanel, props);
  } };
});
vi.mock("./pool-daily-apr-panel", () => ({ PoolDailyAprChart: () => null }));

vi.mock("./withdraw-panel", () => ({ WithdrawPanel: (props: {positionMint: string}) => createElement("div", {"data-testid": "withdraw-target"}, props.positionMint) }));

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
const selectedState = (positionMint: string): SelectedPositionState => ({ wallet: OWN_WALLET, slot: 1, fetchedAt: Date.now(), positionMint, positionAccount: "p", poolId: fixture.poolId,
  programId: "x", inputKind: "token", inputMint: USDC_MINT, inputDecimals: 6, inputTokenProgram: null, inputAccount: NFT_ATA, inputBalance: "1000000",
  mintA: fixture.mintA, mintB: fixture.mintB, decimalsA: 8, decimalsB: 8, programA: "x", programB: "x", nftProgram: "x",
  ataA: "a", ataB: "b", nftAta: NFT_ATA, balances: { a: "0", b: "0", input: "1000000" }, sqrtPriceX64: "1", tickCurrent: 0, tickLower: -10, tickUpper: 10,
  lowerSqrtX64: "1", upperSqrtX64: "2", price: "1", inRange: true, rangeSide: "inside", liquidity: "1", poolLiquidity: "1",
  currentAmounts: { a: "500000000", b: "520000000" }, ownsNft: true, paused: false, transferFee: false, frozen: false, unsupportedExtensions: [],
  wsolBalance: "0", ataAExists: true, ataBExists: true, vaultA: "v", vaultB: "w", tickSpacing: 1,
  solLamports: 1_000_000_000, sufficientSol: true, pricing: { priceUsdInput: 1, priceUsdA: 100, priceUsdB: 50 } });

const stockFixture = {
  symbol: "SPCX", priceMint: fixture.mintA, priceUsd: 100, change24hPct: 1,
  sharesNow: 2, valueUsd: 200, sharesIn: null, firstDepositAtIso: null,
  entryPriceUsd: null, priceChangeUsd: null, priceChangePct: null,
  feeShares: 0.01, feeUsd: 1, totalUsd: null, sparkline24h: [], sparklineSinceEntry: [],
  entryPriceSource: null, entryUnavailableReason: "Entry price unavailable.",
};
type Mode = { wallet: string | null; positions: string[]; stateOk: boolean; initialMint: string; eligible?: boolean; stock?: boolean; performanceFail?: boolean; initialView?: "performance" | "compound" | "deposit" | "withdraw" };
let container: HTMLDivElement; let root: Root;
let calls: string[];
const flush = async (ms = 50) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const settle = async () => { for (let i = 0; i < 20; i++) await flush(100); };
const param = (url: string, name: string) => new URL(url, "http://x").searchParams.get(name);

function mount(mode: Mode) {
  const connected = mode.wallet !== null;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input); calls.push(url);
    if (url.startsWith("/api/wallet?")) return Response.json({ ...discovery(mode.positions), wallet: mode.wallet, assets: mode.eligible === false ? [] : discovery(mode.positions).assets });
    if (url.startsWith("/api/selected-state?")) {
      return mode.stateOk ? Response.json({ ...selectedState(param(url, "positionMint")!), wallet: mode.wallet })
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
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  calls = [];
  safety.enabled = false; safety.staleSnapshot = false; safety.commits = []; safety.add.mockClear(); safety.retry.mockClear();
  compoundMock.state = null; compoundMock.busy = false;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("All positions selection lifecycle", () => {
 const chosen = () => container.querySelector('[data-testid="selected-position-detail"]')?.textContent;
 const lastState = () => calls.filter(u => u.startsWith('/api/selected-state?')).at(-1);
 const pickB = async () => { await act(async () => container.querySelector<HTMLButtonElement>(`[data-testid="position-fallback-select"][data-position-key="raydium-clmm:${OTHER_OWNED_MINT}"]`)!.click()); await settle(); };
 const tab = async (label: string) => { await act(async () => [...container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Position operations"] button')].find(b => b.textContent === label)!.click()); await settle(); };
 const assertTargets = async (mint: string) => {
  expect(container.querySelector(`[data-position-key="raydium-clmm:${mint}"]`)?.getAttribute('aria-pressed')).toBe('true');
  expect(chosen()).toContain(mint);
  expect(param(lastState()!, 'positionMint')).toBe(mint);
  await tab('Withdraw');
  expect(container.querySelector('[data-testid="withdraw-target"]')?.textContent).toBe(mint);
  await tab('Performance');
  expect(safety.performanceMint).toBe(mint);
  expect(calls.some(url => url.startsWith('/api/position-performance?') && param(url, 'positionMint') === mint)).toBe(true);
 };
 const rescan = async () => { await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Rescan wallet')!.click()); await settle(); };
 it('eligible input arrives after read-only pick', async () => {
  const mode: Mode = { wallet: OWN_WALLET, positions: [OWNED_MINT, OTHER_OWNED_MINT], stateOk: true, initialMint: '', initialView: 'deposit', eligible: false };
  await mount(mode); await settle(); await pickB();
  expect(chosen()).toContain(OTHER_OWNED_MINT);
  expect(lastState()).toBeUndefined();
  await tab('Performance');
  expect(safety.performanceMint).toBe(OTHER_OWNED_MINT);
  await tab('Add to position');
  mode.eligible = true; await rescan();
  expect(calls.filter(url => url.startsWith('/api/selected-state?')).every(url => param(url, 'positionMint') === OTHER_OWNED_MINT)).toBe(true);
  expect(chosen()).toContain(OTHER_OWNED_MINT);
  await assertTargets(OTHER_OWNED_MINT);
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Position operations"] button')].find(b => b.textContent === 'Withdraw')!.click()); await settle();
  expect(container.querySelector('[data-testid="withdraw-target"]')?.textContent).toBe(OTHER_OWNED_MINT);
 });
 it('rescan removes picked position', async () => {
  const mode: Mode = { wallet: OWN_WALLET, positions: [OWNED_MINT, OTHER_OWNED_MINT], stateOk: true, initialMint: '', initialView: 'deposit' };
  await mount(mode); await settle(); await pickB();
  mode.positions = [OWNED_MINT]; await rescan();
  await assertTargets(OWNED_MINT);
  expect([...container.querySelectorAll('[data-testid="position-fallback-select"]')].some(b => b.getAttribute('aria-pressed') === 'true')).toBe(true);
 });
 it('wallet A B A', async () => {
  const mode: Mode = { wallet: OWN_WALLET, positions: [OWNED_MINT, OTHER_OWNED_MINT], stateOk: true, initialMint: '', initialView: 'deposit' };
  await mount(mode); await settle(); await pickB();
  mode.wallet = 'OtherWallet111111111111111111111111111'; await mount(mode); await settle();
  mode.wallet = OWN_WALLET; await mount(mode); await settle();
  expect(chosen()).toContain(OWNED_MINT);
  await assertTargets(OWNED_MINT);
 });
 it.each(['deposit', 'withdraw'] as const)('blocks all operation targets before reconciliation in %s', async (initialView) => {
  safety.enabled = true;
  safety.staleSnapshot = initialView === 'withdraw';
  const mode: Mode = { wallet: OWN_WALLET, positions: [OWNED_MINT, OTHER_OWNED_MINT], stateOk: true, initialMint: '', initialView, eligible: false };
  await mount(mode); await settle(); await pickB();
  mode.eligible = true; await rescan();
  const mismatches = safety.commits.filter(c => c.selected.includes(OTHER_OWNED_MINT) && c.target === OWNED_MINT);
  expect(mismatches.length).toBeGreaterThan(0);
  for (const commit of mismatches) {
    expect(commit.addDisabled).toBe(true);
    expect(commit.retry).toBe(false);
    expect(commit.compound).toBe('');
    // No position target is exposed; wallet-wide recovery is deliberately not selection-locked.
    expect(commit.blocked).toBe(false);
    expect(commit.withdraw).toBe('');
  }
  expect(safety.add).not.toHaveBeenCalled();
  expect(safety.retry).not.toHaveBeenCalled();
  await assertTargets(OTHER_OWNED_MINT);
 });
});

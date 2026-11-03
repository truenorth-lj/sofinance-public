// @vitest-environment happy-dom
// Regression: prod 2026-11-02, a 100% withdraw confirmed step 1 but never prompted step 2 (convert to USDC).
// Step 1 closes the position; its confirmation refreshes the selected state, which then reads no position.
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SelectedApp } from "./selected-app";
import { withdrawCheckpoint, withdrawKey, withdrawPosition, withdrawPrepared, withdrawWallet } from "@/lib/test-support/withdraw-checkpoint-fixtures";

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let current: { state: unknown; selection: unknown } = { state: null, selection: null };
  return {
    getSnapshot: () => current,
    select(next: { state?: unknown; selection?: unknown }) { current = { ...current, ...next }; listeners.forEach((l) => l()); },
    sign: vi.fn(), historyChange: vi.fn(),
    setState(next: unknown) { current = { ...current, state: next }; listeners.forEach((l) => l()); },
    subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l); },
  };
});
vi.mock("./use-sol-usdc-price", () => ({ useSolUsdcPrices: () => ({ rate: null, usdcUsd: null }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/app" }));
vi.mock("./use-token-metadata", () => ({ useTokenMetadata: () => ({}) }));
vi.mock("@/lib/position-history-refresh", () => ({ notifyPositionHistoryChange: mocks.historyChange }));
vi.mock("./wallet-connection", () => ({ useWalletConnection: () => ({ address: withdrawWallet, connected: true, signTransaction: mocks.sign, connect: vi.fn() }) }));
vi.mock("./use-selected-controller", () => ({ useSelectedController: () => {
  const { state, selection } = useSyncExternalStore(mocks.subscribe, mocks.getSnapshot);
  return { connected: true, wallet: withdrawWallet, connect: vi.fn(), disconnect: vi.fn(), discovery: null, state, selection,
    quote: null, fresh: true, now: Date.now(), amount: "", tolerancePercent: "1", busy: false, calculating: false,
    status: "", actionLabel: "Add liquidity", actionDisabled: true, primaryAction: vi.fn(), choosePosition: vi.fn(),
    refreshState: vi.fn(), refreshDiscovery: vi.fn(), error: "", connectionError: "" };
} }));
vi.mock("./use-compound-controller", () => ({ useCompoundController: () => ({
  wallet: undefined, state: null, preview: null, attempt: null, stage: "idle", busy: false, canCompound: false,
  compound: vi.fn(), receipts: [], priorReceipts: [], error: "",
}) }));
vi.mock("./transaction-status-dialog", () => ({ TransactionStatusDialog: () => null }));
vi.mock("./pool-daily-apr-panel", () => ({ PoolDailyAprChart: () => null }));
vi.mock("./position-performance-panel", () => ({ PositionPerformancePanel: () => null }));

let container: HTMLDivElement; let root: Root;
const position = { positionMint: withdrawPosition, mintA: "mint-a", mintB: "mint-b", poolId: "pool", decimalsA: 6, decimalsB: 6,
  currentAmounts: { a: "0", b: "0" }, balances: { a: "0", b: "0" }, inRange: true, rangeSide: "in", inputBalance: "0", inputDecimals: 6,
  price: 1, pricing: { priceUsdInput: null }, slot: 1, solLamports: "0", tickLower: 0, tickUpper: 1 };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear(); mocks.sign.mockReset(); mocks.historyChange.mockReset(); mocks.select({ state: position, selection: { positionMint: withdrawPosition, inputMint: "mint-a", inputKind: "token" } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
// Mocks answer by URL, never by call order: the page also reads the registry DEX positions (Meteora, on by default) while
// the Raydium withdrawal runs, and that read must not consume or trigger a Raydium response.
const DEX_POSITIONS = "/api/dex/meteora-dlmm/positions";
const urlOf = (input: unknown) => new URL(String(input), "http://x").pathname;
const click = async (text: string, scope: Element = container) => {
  const b = Array.from(scope.querySelectorAll("button")).find((x) => x.textContent?.trim() === text);
  expect(b, text).toBeDefined(); await act(async () => b!.click());
};

it("prepares and prompts step 2 after step 1 confirms, even though the closed position leaves the selected state", async () => {
  // Step 1 was sent; the panel is waiting for its confirmation.
  localStorage.setItem(withdrawKey, JSON.stringify(withdrawCheckpoint("withdraw")));
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const path = urlOf(input);
    calls.push(path);
    if (path === DEX_POSITIONS) return Response.json({ positions: [] });
    if (path === "/api/withdraw-status") {
      // Step 1 confirmed: the balances refresh now reads the burned position NFT as gone.
      mocks.setState(null);
      return Response.json({ status: "success" });
    }
    if (path === "/api/withdraw-quote") return Response.json(withdrawPrepared("swap").summary);
    if (path === "/api/withdraw-prepare") return Response.json(withdrawPrepared("swap"));
    return Response.json({ error: `unexpected ${path}` }, { status: 500 });
  }));
  mocks.sign.mockRejectedValue(new Error("User rejected the request."));
  await act(async () => root.render(<SelectedApp initialView="withdraw" />));
  const view = container.querySelector("#withdraw-view")!;
  await click("Resume withdrawal", view);
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

  expect(calls.filter((path) => path !== DEX_POSITIONS)).toEqual(["/api/withdraw-status", "/api/withdraw-quote", "/api/withdraw-prepare"]);
  expect(calls).toContain(DEX_POSITIONS);
  // Step 2 reached the wallet.
  expect(mocks.sign).toHaveBeenCalledOnce();
  // The panel is still there and states the real failure, not the "choose a position" fallback.
  expect(view.textContent).not.toContain("Connect your wallet and choose a position to withdraw");
  expect(view.querySelector('[role="alert"]')?.textContent).toMatch(/reject|cancel/i);
  // Nothing was sent on step 2: Resume stays available to retry the conversion.
  expect(Array.from(view.querySelectorAll("button")).some((b) => b.textContent === "Resume withdrawal")).toBe(true);
});

it("still shows the connect/choose prompt when no position was ever selected", async () => {
  mocks.select({ state: null, selection: null });
  await act(async () => root.render(<SelectedApp initialView="withdraw" />));
  expect(container.querySelector("#withdraw-view")?.textContent).toContain("Connect your wallet and choose a position to withdraw");
});

it("does not keep the old position's Withdraw panel when another position is selected and still loading", async () => {
  // Position A has a withdrawal in progress (step 1 sent, Resume pending): the panel is pinned to A.
  localStorage.setItem(withdrawKey, JSON.stringify(withdrawCheckpoint("withdraw")));
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: "pending" })));
  await act(async () => root.render(<SelectedApp initialView="withdraw" />));
  const view = container.querySelector("#withdraw-view")!;
  expect(view.querySelector('section[aria-label="Withdraw from position"]')).not.toBeNull();
  // Switch to position B: its state is still loading (null).
  await act(async () => mocks.select({ state: null, selection: { positionMint: "position-b", inputMint: "mint-a", inputKind: "token" } }));
  expect(view.querySelector('section[aria-label="Withdraw from position"]')).toBeNull();
  expect(view.textContent).toContain("Connect your wallet and choose a position to withdraw");
});

it("releases the pinned panel once the withdrawal finishes", async () => {
  // Step 2 was sent; confirming it completes the withdrawal of the (now closed) position.
  localStorage.setItem(withdrawKey, JSON.stringify(withdrawCheckpoint("swap")));
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const path = urlOf(input);
    calls.push(path);
    if (path === DEX_POSITIONS) return Response.json({ positions: [] });
    if (path === "/api/withdraw-status") { mocks.setState(null); return Response.json({ status: "success" }); }
    return Response.json({ error: `unexpected ${path}` }, { status: 500 });
  }));
  await act(async () => root.render(<SelectedApp initialView="withdraw" />));
  const view = container.querySelector("#withdraw-view")!;
  // The Meteora read already happened, and Resume withdrawal (#297) is still offered.
  expect(calls).toContain(DEX_POSITIONS);
  await click("Resume withdrawal", view);
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  expect(calls).toContain("/api/withdraw-status");
  expect(localStorage.getItem(withdrawKey)).toBeNull();
  expect(view.querySelector('section[aria-label="Withdraw from position"]')).toBeNull();
  expect(view.textContent).toContain("Connect your wallet and choose a position to withdraw");
});

it.each([["hangs", () => new Promise<Response>(() => {})], ["fails (500)", () => Response.json({ error: "Meteora is down" }, { status: 500 })]] as const)(
  "the Raydium withdrawal resumes and prompts step 2 while the Meteora positions read %s", async (_label, meteora) => {
    localStorage.setItem(withdrawKey, JSON.stringify(withdrawCheckpoint("withdraw")));
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = urlOf(input);
      calls.push(path);
      if (path === DEX_POSITIONS) return meteora();
      if (path === "/api/withdraw-status") { mocks.setState(null); return Response.json({ status: "success" }); }
      if (path === "/api/withdraw-quote") return Response.json(withdrawPrepared("swap").summary);
      if (path === "/api/withdraw-prepare") return Response.json(withdrawPrepared("swap"));
      return Response.json({ error: `unexpected ${path}` }, { status: 500 });
    }));
    mocks.sign.mockRejectedValue(new Error("User rejected the request."));
    await act(async () => root.render(<SelectedApp initialView="withdraw" />));
    const view = container.querySelector("#withdraw-view")!;
    expect(calls).toContain(DEX_POSITIONS);
    await click("Resume withdrawal", view);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(calls.filter((path) => path !== DEX_POSITIONS)).toEqual(["/api/withdraw-status", "/api/withdraw-quote", "/api/withdraw-prepare"]);
    expect(mocks.sign).toHaveBeenCalledOnce();
  });

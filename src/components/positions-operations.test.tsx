// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectedApp } from "./selected-app";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), deposit: vi.fn(), compound: vi.fn(), depositQuote: false, connected: false }));
const WALLET = "11111111111111111111111111111112", POSITION = "So11111111111111111111111111111111111111112";
vi.mock("./use-sol-usdc-price", () => ({ useSolUsdcPrices: () => ({ rate: null, usdcUsd: null }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/app" }));
vi.mock("./use-token-metadata", () => ({ useTokenMetadata: () => ({}) }));
vi.mock("./wallet-connection", () => ({ useWalletConnection: () => ({ connected: false, connect: mocks.connect }) }));
vi.mock("./use-selected-controller", () => ({ useSelectedController: () => ({
  connected: mocks.connected, wallet: mocks.connected ? WALLET : "", connect: mocks.connect, disconnect: vi.fn(), discovery: null, state: null,
  selection: mocks.connected ? { positionMint: POSITION, inputMint: POSITION, inputKind: "token" } : null,
  quote: mocks.depositQuote ? { requested: "10000000", roundtripCostInput: "137000",
    resaleInput: "9863000", passesFloor: false, inputDecimals: 9, spendA: "0", spendB: "0",
    minOutA: "0", minOutB: "0", expiresAt: Date.now() + 30000 } : null,
  fresh: true, now: Date.now(),
  amount: "", tolerancePercent: "1", busy: false, calculating: false,
  status: "Please connect wallet first", actionLabel: "Add liquidity", actionDisabled: true,
  primaryAction: mocks.deposit, choosePosition: vi.fn(), error: "", connectionError: "",
}) }));
vi.mock("./use-compound-controller", () => ({ useCompoundController: () => ({
  wallet: undefined, state: null, preview: null, attempt: null, stage: "idle", busy: false, canCompound: false,
  compound: mocks.compound, receipts: [], priorReceipts: [], error: "",
}) }));
vi.mock("./transaction-status-dialog", () => ({ TransactionStatusDialog: () => null }));
vi.mock("./pool-daily-apr-panel", () => ({ PoolDailyAprChart: () => null }));
let container: HTMLDivElement;
let root: Root;

function button(label: string, scope: Element = container) {
  const found = Array.from(scope.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
  expect(found, label).toBeDefined();
  return found!;
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks(); mocks.depositQuote = false; mocks.connected = false;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(SelectedApp)));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("Positions while disconnected", () => {
  it("shows the one empty state: no tool tabs, no Compound panel, no Auto Copilot", async () => {
    const list = container.querySelector('[aria-labelledby="all-positions-heading"]')!;
    const empty = list.querySelector('[data-testid="positions-empty-state"]')!;
    expect(empty.textContent).toContain("Connect your wallet to see your positions.");
    expect(empty.querySelector('a[href="/app/rwa-pairs"]')?.textContent).toBe("Go to Pools");
    expect(container.querySelector('nav[aria-label="Position operations"]')).toBeNull();
    expect(container.querySelector("select#position-action")).toBeNull();
    expect(container.querySelector("#compound-view")).toBeNull();
    expect(container.querySelector("#deposit-view")).toBeNull();
    expect(container.textContent).not.toContain("Auto Copilot");
    expect(container.textContent).not.toContain("Manage my liquidity positions");
    expect(Array.from(container.querySelectorAll('nav[aria-label="App"] a')).map((a) => a.textContent)).not.toContain("Performance");
    expect(container.textContent).not.toContain("Please connect wallet first");
    expect(container.textContent).not.toContain("Wallet extensions not detected");
    expect(container.textContent).not.toContain("Reown Project ID");
  });
  it("connects from the empty state without starting anything", async () => {
    await act(async () => button("Connect wallet", container.querySelector('[data-testid="positions-empty-state"]')!).click());
    expect(mocks.connect).toHaveBeenCalledOnce(); expect(mocks.deposit).not.toHaveBeenCalled(); expect(mocks.compound).not.toHaveBeenCalled();
  });
});

describe("Positions operations for a selected position", () => {
  it("orders the tool tabs inside the selected position's detail: no Compound fees tab, Add to position open by default", async () => {
    mocks.connected = true;
    await act(async () => root.render(createElement(SelectedApp)));
    const detail = container.querySelector('[data-testid="selected-position-detail"]')!;
    expect(Array.from(detail.querySelectorAll('nav[aria-label="Position operations"] button')).map((b) => b.textContent?.trim()))
      .toEqual(["Performance", "Add to position", "Withdraw"]);
    expect(Array.from(detail.querySelectorAll<HTMLOptionElement>("select#position-action option")).map((o) => [o.textContent, o.disabled]))
      .toEqual([["Performance", false], ["Add to position", false], ["Withdraw", true]]);
    expect(container.querySelector<HTMLElement>("#deposit-view")?.hidden).toBe(false);
    expect(container.querySelector("#compound-view")).toBeNull();
    expect(container.textContent).not.toContain("One-click compound");
    await act(async () => button("Performance").click());
    expect(container.querySelector<HTMLElement>("#performance-view")?.hidden).toBe(false);
    expect(container.querySelector("#compound-view")).toBeNull();
    expect(container.querySelector("#perf-position")).toBeNull();
    expect(container.querySelector("#perf-heading")).toBeNull();
    expect(container.textContent).not.toContain("Compute performance");
    expect(container.textContent).not.toContain("Auto Copilot");
  });
});

it("shows Total cost as a reminder without a resale threshold setting", async () => {
  mocks.depositQuote = true; mocks.connected = true;
  await act(async () => root.render(createElement(SelectedApp)));
  const deposit = container.querySelector("#deposit-view")!;
  expect(deposit.textContent).toContain("Total cost");
  expect(deposit.textContent).toContain("~1.37%");
  expect(deposit.textContent).toContain("It does not block signing.");
  expect(deposit.textContent).not.toContain("Your minimum resale setting");
  expect(deposit.querySelector("#max-cost")).toBeNull();
});

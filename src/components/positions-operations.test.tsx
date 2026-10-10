// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectedApp } from "./selected-app";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), deposit: vi.fn(), compound: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/app" }));
vi.mock("./use-token-metadata", () => ({ useTokenMetadata: () => ({}) }));
vi.mock("./wallet-connection", () => ({ useWalletConnection: () => ({ connected: false, connect: mocks.connect }) }));
vi.mock("./use-selected-controller", () => ({ useSelectedController: () => ({
  connected: false, wallet: "", connect: mocks.connect, disconnect: vi.fn(), discovery: null, state: null,
  amount: "", maxCostPercent: "1", tolerancePercent: "1", busy: false, calculating: false,
  status: "Please connect wallet first", actionLabel: "Deposit funds", actionDisabled: true,
  primaryAction: mocks.deposit, choosePosition: vi.fn(), error: "", connectionError: "",
}) }));
vi.mock("./use-compound-controller", () => ({ useCompoundController: () => ({
  wallet: undefined, state: null, preview: null, attempt: null, stage: "idle", busy: false, canCompound: false,
  compound: mocks.compound, receipts: [], priorReceipts: [], error: "",
}) }));
vi.mock("./transaction-status-dialog", () => ({ TransactionStatusDialog: () => null }));
vi.mock("./pool-activity-panel", () => ({ PoolActivityPanel: () => null }));
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
  vi.clearAllMocks();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(SelectedApp)));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("Positions operations while disconnected", () => {
  it("orders the operations and keeps Performance inside Positions", async () => {
    expect(Array.from(container.querySelectorAll('nav[aria-label="Position operations"] button')).map((b) => b.textContent?.trim()))
      .toEqual(["Yield Compound", "Performance", "Deposit funds"]);
    expect(Array.from(container.querySelectorAll('nav[aria-label="App"] a')).map((a) => a.textContent)).not.toContain("Performance");
    await act(async () => button("Performance").click());
    expect(container.querySelector<HTMLElement>("#performance-view")?.hidden).toBe(false);
    expect(container.querySelector<HTMLElement>("#compound-view")?.hidden).toBe(true);
    expect(container.querySelector("#perf-position")).toBeNull();
    await act(async () => button("Compute performance").click());
    expect(mocks.connect).toHaveBeenCalledOnce();
  });
  it("connects on compound without starting a transaction and links Auto Copilot to Use AI", async () => {
    const compound = button("One-click compound");
    expect(compound.disabled).toBe(false);
    await act(async () => compound.click());
    expect(mocks.connect).toHaveBeenCalledOnce(); expect(mocks.compound).not.toHaveBeenCalled();
    expect(container.querySelector('#compound-view a[href="/app/ai"]')?.textContent).toContain("Auto Copilot");
    expect(container.textContent).not.toContain("Please connect wallet first");
    expect(container.textContent).not.toContain("Wallet extensions not detected");
    expect(container.textContent).not.toContain("Reown Project ID");
  });
  it("connects on deposit and shows the shared wallet prompt", async () => {
    await act(async () => button("Deposit funds", container.querySelector('nav[aria-label="Position operations"]')!).click());
    const deposit = button("Connect wallet", container.querySelector("#deposit-view")!);
    expect(deposit.disabled).toBe(false);
    await act(async () => deposit.click());
    expect(mocks.connect).toHaveBeenCalledOnce(); expect(mocks.deposit).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Connect your wallet to find your liquidity positions.");
    expect(container.textContent).not.toContain("Please connect wallet first");
  });
});

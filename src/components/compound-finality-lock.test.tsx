// @vitest-environment happy-dom
import { act, createElement, type FunctionComponent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectedApp } from "./selected-app";
import { useCompoundController, type CompoundConfirmation } from "./use-compound-controller";
import { compoundAttemptKey, compoundReceiptsKey, persistCompoundAttempt } from "@/lib/compound-attempt";
import { compoundHistoryFixture } from "@/lib/test-support/compound-history-fixture";
import { testKeypair } from "@/lib/test-support/send-fixtures";
import { USDC_MINT } from "@/lib/ids";

const mocks = vi.hoisted(() => ({ add: vi.fn(), sign: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/app" }));
vi.mock("./use-sol-usdc-price", () => ({ useSolUsdcPrices: () => ({ rate: null, usdcUsd: null }) }));
vi.mock("./use-token-metadata", () => ({ useTokenMetadata: () => ({}) }));
vi.mock("./wallet-connection", () => ({ useWalletConnection: () => ({ address: activeWallet, connected: !!activeWallet, signTransaction: mocks.sign }) }));
vi.mock("./use-selected-controller", () => ({ useSelectedController: () => ({
  wallet: activeWallet, connected: !!activeWallet, connect: vi.fn(), disconnect: vi.fn(), discovery: null, state: null,
  selection: { positionMint: selectedMint, inputMint: USDC_MINT, inputKind: "token" }, amount: "200", tolerancePercent: "2.0",
  result: { simulated: true }, calculating: false, quote: null, status: "Estimation complete, ready to send to wallet for signing",
  actionLabel: "Add liquidity", actionDisabled: false, primaryAction: mocks.add, walletBlocked: false, busy: false,
  refreshState: mocks.refresh, choosePosition: vi.fn(), chooseAsset: vi.fn(), changeAmount: vi.fn(),
}) }));
vi.mock("./transaction-status-dialog", () => ({ TransactionStatusDialog: () => null }));
vi.mock("./use-compound-controller", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./use-compound-controller")>();
  return { ...actual, useCompoundController: (args: Parameters<typeof actual.useCompoundController>[0]) => {
    controller = actual.useCompoundController(args); return controller;
  } };
});

let activeWallet: string | undefined;
let selectedMint: string;
let controller: ReturnType<typeof useCompoundController>;
let container: HTMLDivElement, root: Root;
let fixture: ReturnType<typeof compoundHistoryFixture>;
let reply: Omit<CompoundConfirmation, "signature"> & { signature?: string };
let fetchMock: ReturnType<typeof vi.fn>;
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const addButton = () => [...container.querySelectorAll<HTMLButtonElement>("#deposit-view button")].find((b) => b.textContent === "Add liquidity")!;
const confirmCalls = () => fetchMock.mock.calls.filter(([url]) => url === "/api/compound-confirm").length;
async function render(initialView: "compound" | "deposit" = "deposit") {
  await act(async () => root.render(createElement(SelectedApp as FunctionComponent<{ initialView: "compound" | "deposit" }>, { initialView })));
  await advance(1); await advance(1);
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); window.localStorage.clear();
  fixture = compoundHistoryFixture(); activeWallet = fixture.wallet;
  selectedMint = testKeypair(80).publicKey.toBase58(); // The old compound belongs to another NFT.
  mocks.add.mockReset(); mocks.sign.mockReset(); mocks.refresh.mockReset();
  persistCompoundAttempt(window.localStorage, fixture.attempt);
  reply = { status: "pending", chainStatus: "pending", state: null };
  fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/compound-state") return Response.json({ ...fixture.state, wallet: activeWallet, positionMint: selectedMint });
    if (url === "/api/compound-confirm") return Response.json({ signature: fixture.attempt.signature, ...reply });
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe("compound execution lock in the real SelectedApp", () => {
  it("allows adding to another NFT after finalized success with an incomplete receipt, retaining evidence and warning", async () => {
    reply = { status: "manual-review", chainStatus: "success", state: null };
    await render();
    expect(controller.walletBlocked).toBe(false);
    expect(controller.receiptReviewRequired).toBe(true);
    expect(addButton().disabled).toBe(false);
    expect(container.querySelector("#deposit-view")!.textContent).toContain("Estimation complete, ready to send to wallet for signing");
    expect(container.textContent).toContain("Previous transaction finalized successfully; yield details need verification. You can add liquidity.");
    expect(controller.canCompound).toBe(false); expect(controller.ready).toBe(false);
    expect(window.localStorage.getItem(compoundAttemptKey(fixture.wallet))).toBe(JSON.stringify(fixture.attempt));
    expect(JSON.parse(window.localStorage.getItem(compoundReceiptsKey(fixture.wallet))!)).toHaveLength(1);
    await act(async () => addButton().click()); expect(mocks.add).toHaveBeenCalledOnce(); expect(mocks.sign).not.toHaveBeenCalled();
  });
  it("keeps pending transactions locked after 30 seconds, rechecks and replaces the misleading ready text", async () => {
    await render(); expect(addButton().disabled).toBe(true);
    expect(container.querySelector("#deposit-view")!.textContent).not.toContain("ready to send to wallet");
    await advance(29_997); expect(controller.confirmationSlow).toBe(false);
    const before = confirmCalls(); await advance(1);
    expect(controller.confirmationSlow).toBe(true); expect(confirmCalls()).toBe(before + 1);
    expect(addButton().disabled).toBe(true);
    expect(container.querySelector("#deposit-view")!.textContent).toContain("Confirmation is taking longer than 30 seconds");
    await act(async () => addButton().click()); expect(mocks.add).not.toHaveBeenCalled();
    await advance(60_000); expect(controller.walletBlocked).toBe(true);
  });
  it("continues automatic reconciliation for unknown manual-review and unlocks when history later proves success", async () => {
    reply = { status: "manual-review", chainStatus: "unknown", state: null };
    await render(); expect(controller.walletBlocked).toBe(true);
    const before = confirmCalls(); await advance(4_000); expect(confirmCalls()).toBeGreaterThan(before);
    reply = { status: "success", chainStatus: "success", state: null };
    await advance(4_000); expect(addButton().disabled).toBe(false); expect(controller.receiptReviewRequired).toBe(false);
  });
  it.each(["success", "failed", "expired"] as const)("unlocks after confirmed %s and preserves legacy API compatibility", async (status) => {
    reply = { status, state: null };
    await render(); expect(controller.walletBlocked).toBe(false); expect(addButton().disabled).toBe(false);
  });
  it("does not infer finality from a legacy manual-review response or a mismatched signature", async () => {
    reply = { status: "manual-review", state: null };
    await render(); expect(controller.walletBlocked).toBe(true);
    reply = { signature: "different", status: "manual-review", chainStatus: "success", state: null };
    await advance(4_000); expect(controller.walletBlocked).toBe(true);
    expect(controller.error).toBe("");
    expect(controller.attemptError).toContain("signature or status mismatch");
  });
  it("reloads and rechecks an old successful attempt instead of persisting its previous manual-review lock", async () => {
    reply = { status: "manual-review", chainStatus: "success", state: null };
    await render(); expect(addButton().disabled).toBe(false);
    await act(async () => root.unmount()); root = createRoot(container);
    reply = { status: "success", chainStatus: "success", state: null };
    await render(); expect(confirmCalls()).toBeGreaterThanOrEqual(2);
    expect(addButton().disabled).toBe(false); expect(controller.receiptReviewRequired).toBe(false);
  });
  it("does not carry another wallet's successful chain status across a wallet change", async () => {
    reply = { status: "manual-review", chainStatus: "success", state: null };
    await render(); expect(controller.walletBlocked).toBe(false);
    const next = compoundHistoryFixture();
    activeWallet = testKeypair(90).publicKey.toBase58();
    next.attempt.wallet = activeWallet; next.attempt.summary.state.wallet = activeWallet;
    persistCompoundAttempt(window.localStorage, next.attempt);
    reply = { status: "pending", chainStatus: "pending", state: null };
    await render(); expect(controller.walletBlocked).toBe(true); expect(addButton().disabled).toBe(true);
  });
  it("keeps another NFT's successful transaction and receipts in explicitly labelled collapsed history", async () => {
    reply = { status: "success", chainStatus: "success", state: null };
    await render("compound");
    const view = container.querySelector("#compound-view")!;
    const success = [...view.querySelectorAll('[role="status"]')].find(node => node.textContent === "Compound confirmed on-chain")!;
    expect(success.closest("details")!.open).toBe(false);
    expect(success.closest("details")!.querySelector("summary")!.textContent).toContain("Previous transaction for another position");
    expect(view.textContent).toContain("0 records for this position");
    expect(view.textContent).toContain("Other positions (1 records)");
    expect(controller.canCompound).toBe(true);
    selectedMint = fixture.attempt.positionMint;
    await render("compound");
    const selectedSuccess = [...view.querySelectorAll('[role="status"]')].find(node => node.textContent === "Compound confirmed on-chain")!;
    expect(selectedSuccess.closest("details")).toBeNull();
    expect(view.textContent).toContain("1 records for this position");
    expect(view.textContent).not.toContain("Other positions (1 records)");
  });
  it.each([false, true])("scopes failed preparation and retains it when old success is requeried (same NFT: %s)", async sameNft => {
    if (sameNft) selectedMint = fixture.attempt.positionMint;
    reply = { status: "success", chainStatus: "success", state: null };
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/compound-state") return Response.json({ ...fixture.state, wallet: activeWallet, positionMint: selectedMint });
      if (url === "/api/compound-confirm") return Response.json({ signature: fixture.attempt.signature, ...reply });
      if (url === "/api/compound-prepare") return Response.json({ error: "Complete compound transaction 1268 bytes, exceeds 1,232 byte limit" }, { status: 400 });
      throw new Error(`Unexpected request ${url}`);
    });
    await render("compound");
    await act(async () => controller.compound());
    expect(controller.error).toContain("1268 bytes");
    expect(controller.attempt?.signature).toBe(fixture.attempt.signature);
    await act(async () => controller.retryReconcile());
    expect(controller.error).toContain("1268 bytes");
    selectedMint = sameNft ? testKeypair(80).publicKey.toBase58() : fixture.attempt.positionMint;
    await render("compound");
    expect(controller.error).toBe("");
    expect(mocks.sign).not.toHaveBeenCalled();
  });
});

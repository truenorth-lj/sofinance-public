// @vitest-environment happy-dom
import { act, createElement, type FunctionComponent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectedApp } from "./selected-app";
import { useCompoundController, type CompoundConfirmation } from "./use-compound-controller";
import { compoundAttemptKey, compoundReceiptsKey, persistCompoundAttempt } from "@sofinance/engine/compound-attempt";
import { compoundHistoryFixture } from "@/lib/test-support/compound-history-fixture";
import { TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { testKeypair } from "@/lib/test-support/send-fixtures";
import { USDC_MINT } from "@sofinance/engine/ids";

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

describe("compound history warnings in the real SelectedApp", () => {
  it("allows adding to another NFT after finalized success with an incomplete receipt, retaining evidence and warning", async () => {
    reply = { status: "manual-review", chainStatus: "success", state: null };
    await render();
    expect(controller.walletBlocked).toBe(false);
    expect(controller.receiptReviewRequired).toBe(true);
    expect(addButton().disabled).toBe(false);
    expect(container.querySelector("#deposit-view")!.textContent).toContain("Estimation complete, ready to send to wallet for signing");
    expect(container.textContent).toContain("A previous compound transaction finalized, but its yield details need verification. New transactions are available.");
    expect(controller.canCompound).toBe(true); expect(controller.ready).toBe(true);
    expect(window.localStorage.getItem(compoundAttemptKey(fixture.wallet))).toBe(JSON.stringify(fixture.attempt));
    expect(JSON.parse(window.localStorage.getItem(compoundReceiptsKey(fixture.wallet))!)).toHaveLength(1);
    await act(async () => addButton().click()); expect(mocks.add).toHaveBeenCalledOnce(); expect(mocks.sign).not.toHaveBeenCalled();
  });
  it("warns about old pending transactions without blocking after 30 seconds or sending automatically", async () => {
    await render(); expect(addButton().disabled).toBe(false);
    expect(controller.historyWarning).toContain("unresolved"); expect(controller.canCompound).toBe(true);
    await advance(29_997); expect(controller.confirmationSlow).toBe(false);
    const before = confirmCalls(); await advance(1);
    expect(controller.confirmationSlow).toBe(true); expect(confirmCalls()).toBe(before + 1);
    expect(addButton().disabled).toBe(false); expect(controller.walletBlocked).toBe(false);
    await advance(60_000); expect(controller.walletBlocked).toBe(false);
    expect(mocks.sign).not.toHaveBeenCalled(); expect(mocks.add).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => /broadcast$/.test(url))).toBe(false);
  });
  it("continues automatic reconciliation for unknown history while fresh operations stay enabled", async () => {
    reply = { status: "manual-review", chainStatus: "unknown", state: null };
    await render(); expect(controller.walletBlocked).toBe(false);
    const before = confirmCalls(); await advance(4_000); expect(confirmCalls()).toBeGreaterThan(before);
    reply = { status: "success", chainStatus: "success", state: null };
    await advance(4_000); expect(addButton().disabled).toBe(false); expect(controller.receiptReviewRequired).toBe(false);
  });
  it.each(["success", "failed", "expired"] as const)("unlocks after confirmed %s and preserves legacy API compatibility", async (status) => {
    reply = { status, state: null };
    await render(); expect(controller.walletBlocked).toBe(false); expect(addButton().disabled).toBe(false);
  });
  it("keeps unknown or mismatched historical results as warnings without inferring finality", async () => {
    reply = { status: "manual-review", state: null };
    await render(); expect(controller.walletBlocked).toBe(false);
    reply = { signature: "different", status: "manual-review", chainStatus: "success", state: null };
    await advance(4_000); expect(controller.walletBlocked).toBe(false);
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
    await render(); expect(controller.walletBlocked).toBe(false); expect(addButton().disabled).toBe(false);
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
  it("shows a failed other-NFT recovery beside its receipt and keeps its evidence", async () => {
    reply = { status: "success", chainStatus: "success", state: null };
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/compound-state") return Response.json({ ...fixture.state, wallet: activeWallet, positionMint: selectedMint });
      if (url === "/api/compound-confirm") return Response.json({ signature: fixture.attempt.signature, ...reply });
      if (url === "/api/compound-recover-prepare") return Response.json({ error: "Recovery simulation failed" }, { status: 400 });
      throw new Error(`Unexpected request ${url}`);
    });
    await render("compound");
    await act(async () => controller.recover(controller.receipts[0]!));
    expect(controller.error).toBe("");
    expect(controller.recoveryError).toEqual({ sourceSignature: fixture.attempt.signature, message: "Recovery simulation failed" });
    const alert = container.querySelector('#compound-view [role="alert"]')!;
    expect(alert.textContent).toBe("Recovery simulation failed");
    expect(alert.closest("details")!.querySelector("summary")!.textContent).toBe("Other positions (1 records)");
    expect(controller.receipts).toHaveLength(1); expect(mocks.sign).not.toHaveBeenCalled();
  });
});


function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function freshPrepared() {
  const summary = { ...fixture.attempt.summary, positionMint: selectedMint,
    state: { ...fixture.state, positionMint: selectedMint }, simulatedAt: Date.now(), expiresAt: Date.now() + 60_000 };
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: testKeypair(1).publicKey,
    recentBlockhash: summary.blockhash, instructions: [] }).compileToV0Message());
  return { summary, permit: "synthetic", unsignedTransaction: Buffer.from(tx.serialize()).toString("base64") };
}

describe("fresh compound ownership and historical evidence", () => {
  it.each(["pending", "manual-review", "failed", "expired"] as const)("does not reuse an old %s receipt while preparing fresh fees", async status => {
    selectedMint = fixture.attempt.positionMint; reply = { status, state: null };
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/compound-state") return Response.json({ ...fixture.state, positionMint: selectedMint });
      if (url === "/api/compound-confirm") return Response.json({ signature: fixture.attempt.signature, ...reply });
      if (url === "/api/compound-prepare") {
        expect(JSON.parse(String(init?.body)).sourceSignatures).toEqual([]);
        return Response.json({ error: "fresh preparation failed" }, { status: 400 });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    await render("compound"); expect(controller.canCompound).toBe(true);
    await act(async () => controller.compound());
    expect(controller.error).toBe("fresh preparation failed");
    expect(window.localStorage.getItem(compoundAttemptKey(fixture.wallet))).toBe(JSON.stringify(fixture.attempt));
    expect(mocks.sign).not.toHaveBeenCalled();
  });
  it.each(["attempt", "receipts"] as const)("invalid historical %s does not disable fresh compound or request a signature automatically", async kind => {
    window.localStorage.setItem(kind === "attempt" ? compoundAttemptKey(fixture.wallet) : compoundReceiptsKey(fixture.wallet), "{invalid");
    await render("compound");
    expect(controller.canCompound).toBe(true); expect(controller.ready).toBe(true); expect(controller.walletBlocked).toBe(false);
    expect(controller.historyWarning).toContain("cannot be verified");
    expect(mocks.sign).not.toHaveBeenCalled(); expect(fetchMock.mock.calls.some(([url]) => /prepare|broadcast$/.test(url))).toBe(false);
  });
  it.each([false, true])("a late old confirmation %s cannot replace a new preparation error", async rejected => {
    const old = deferred<Response>();
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/compound-state") return Response.json({ ...fixture.state, positionMint: selectedMint });
      if (url === "/api/compound-confirm") return old.promise;
      if (url === "/api/compound-prepare") return Response.json({ error: "fresh size check failed" }, { status: 400 });
      throw new Error(`Unexpected request ${url}`);
    });
    await render("compound"); await act(async () => controller.compound());
    await act(async () => {
      if (rejected) old.reject(new Error("old RPC failed"));
      else old.resolve(Response.json({ signature: fixture.attempt.signature, status: "success", chainStatus: "success", state: null }));
    });
    expect(controller.error).toBe("fresh size check failed"); expect(controller.attemptStatus).toBe("pending");
    expect(controller.confirmation).toBeNull(); expect(controller.busy).toBe(false);
    expect(window.localStorage.getItem(compoundAttemptKey(fixture.wallet))).toBe(JSON.stringify(fixture.attempt));
  });
  it("blocks concurrent clicks only while the new operation is running and releases on broadcast response without waiting for confirmation", async () => {
    const prepare = deferred<Response>(); const confirm = deferred<Response>();
    let newSignature = "";
    mocks.sign.mockImplementation(async (tx: VersionedTransaction) => { tx.sign([testKeypair(1)]); newSignature = bs58.encode(tx.signatures[0]!); return tx; });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/compound-state") return Response.json({ ...fixture.state, positionMint: selectedMint });
      if (url === "/api/compound-confirm") return confirm.promise;
      if (url === "/api/compound-prepare") return prepare.promise;
      if (url === "/api/compound-broadcast") {
        expect(JSON.parse(String(init?.body)).positionMint).toBe(selectedMint);
        return Response.json({ signature: newSignature });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    await render("compound");
    await act(async () => { controller.compound(); controller.compound(); });
    expect(controller.busy).toBe(true); expect(controller.walletBlocked).toBe(true);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/compound-prepare")).toHaveLength(1);
    await act(async () => prepare.resolve(Response.json(freshPrepared())));
    expect(controller.busy).toBe(false); expect(controller.walletBlocked).toBe(false); expect(controller.attempt?.signature).toBe(newSignature);
    expect(window.localStorage.getItem(`${compoundAttemptKey(fixture.wallet)}:history:${fixture.attempt.signature}`)).toBe(JSON.stringify(fixture.attempt));
    expect(mocks.sign).toHaveBeenCalledOnce();
    await act(async () => confirm.resolve(Response.json({ signature: newSignature, status: "pending", state: null })));
  });
});


it("automatically uses only the currently verified successful source and leaves older receipts for explicit recovery", async () => {
  selectedMint = fixture.attempt.positionMint;
  const older = { ...fixture.attempt, signature: bs58.encode(new Uint8Array(64).fill(8)) };
  window.localStorage.setItem(compoundReceiptsKey(fixture.wallet), JSON.stringify([older, fixture.attempt].map(item => ({
    wallet: item.wallet, positionMint: item.positionMint, sourceSignature: item.signature, compoundAccounts: item.summary.compoundAccounts,
  }))));
  reply = { status: "success", chainStatus: "success", state: null };
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/compound-state") return Response.json(fixture.state);
    if (url === "/api/compound-confirm") return Response.json({ signature: fixture.attempt.signature, ...reply });
    if (url === "/api/compound-prepare") {
      expect(JSON.parse(String(init?.body)).sourceSignatures).toEqual([fixture.attempt.signature]);
      return Response.json({ error: "prepare stopped for test" }, { status: 400 });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  await render("compound"); await act(async () => controller.compound());
  expect(controller.receipts).toHaveLength(2); expect(mocks.sign).not.toHaveBeenCalled();
});

it("a broadcast timeout unlocks fresh operations while preserving the signature and never resends automatically", async () => {
  const prepare = deferred<Response>(); const confirm = deferred<Response>();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const timeout = new AbortController(); setTimeout(() => timeout.abort(new DOMException("Timed out", "TimeoutError")), ms); return timeout.signal;
  });
  mocks.sign.mockImplementation(async (tx: VersionedTransaction) => { tx.sign([testKeypair(1)]); return tx; });
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/compound-state") return Response.json({ ...fixture.state, positionMint: selectedMint });
    if (url === "/api/compound-confirm") return confirm.promise;
    if (url === "/api/compound-prepare") return prepare.promise;
    if (url === "/api/compound-broadcast") return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
    throw new Error(`Unexpected request ${url}`);
  });
  await render("compound"); await act(async () => controller.compound());
  await act(async () => prepare.resolve(Response.json(freshPrepared())));
  const signature = controller.attempt!.signature;
  expect(controller.busy).toBe(true); expect(AbortSignal.timeout).toHaveBeenCalledWith(15_000);
  await advance(15_000); expect(controller.busy).toBe(false); expect(controller.walletBlocked).toBe(false);
  expect(controller.attempt?.signature).toBe(signature); expect(controller.historyWarning).toContain("unresolved");
  expect(JSON.parse(window.localStorage.getItem(compoundAttemptKey(fixture.wallet))!).signature).toBe(signature);
  await advance(60_000);
  expect(fetchMock.mock.calls.filter(([url]) => url === "/api/compound-broadcast")).toHaveLength(1);
  expect(mocks.sign).toHaveBeenCalledOnce();
  await act(async () => confirm.resolve(Response.json({ signature, status: "pending", state: null })));
});


it("a late historical import error cannot erase a newer preparation error", async () => {
  const imported = deferred<Response>();
  fetchMock.mockImplementation(async (url: string) => {
    if (url === "/api/compound-state") return Response.json({ ...fixture.state, positionMint: selectedMint });
    if (url === "/api/compound-confirm") return Response.json({ signature: fixture.attempt.signature, status: "pending", state: null });
    if (url === "/api/compound-recover-import") return imported.promise;
    if (url === "/api/compound-prepare") return Response.json({ error: "new prepare failed" }, { status: 400 });
    throw new Error(`Unexpected request ${url}`);
  });
  await render("compound");
  let importWork!: Promise<void>;
  await act(async () => { importWork = controller.importReceipt(fixture.attempt.signature); });
  await act(async () => controller.compound());
  await act(async () => { imported.reject(new Error("old import failed")); await importWork; });
  expect(controller.error).toBe("new prepare failed"); expect(controller.busy).toBe(false);
});

it("continues checking retained old history after a new prepare fails", async () => {
  const handler = fetchMock.getMockImplementation() as (url: string) => Promise<Response>;
  fetchMock.mockImplementation(async (url: string) => url === "/api/compound-prepare"
    ? Response.json({ error: "Fresh preparation failed" }, { status: 400 }) : handler(url));
  await render("compound");
  await act(async () => controller.compound());
  const before = confirmCalls();
  await advance(4_000);
  expect(confirmCalls()).toBeGreaterThan(before);
  expect(controller.error).toBe("Fresh preparation failed");
  expect(controller.walletBlocked).toBe(false);
  expect(mocks.sign).not.toHaveBeenCalled();
});

describe("one-click compound submit dialog", () => {
  async function submitWith(confirmReply: () => Response | Promise<Response>) {
    let newSignature = "";
    mocks.sign.mockImplementation(async (tx: VersionedTransaction) => { tx.sign([testKeypair(1)]); newSignature = bs58.encode(tx.signatures[0]!); return tx; });
    const broadcast = deferred<Response>();
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/compound-state") return Response.json({ ...fixture.state, positionMint: selectedMint });
      if (url === "/api/compound-confirm") return confirmReply();
      if (url === "/api/compound-prepare") return Response.json(freshPrepared());
      if (url === "/api/compound-broadcast") return broadcast.promise;
      throw new Error(`Unexpected request ${url}`);
    });
    await render("compound");
    await act(async () => controller.compound()); await advance(1);
    return { signature: () => newSignature, broadcast };
  }
  const dialog = () => container.querySelector<HTMLDialogElement>("dialog[aria-labelledby='compound-submit-title']");
  const button = (label: string) => [...dialog()!.querySelectorAll("button")].find(b => b.textContent === label);

  it("shows submitting → confirming → confirmed with Solscan, and OK refreshes the position", async () => {
    let status: "pending" | "success" = "pending"; let sig = "";
    const run = await submitWith(() => Response.json({ signature: sig, status, chainStatus: status, state: null }));
    sig = run.signature();
    expect(controller.feedback).toMatchObject({ phase: "submitting", signature: sig });
    expect(dialog()?.textContent).toContain("Submitting…"); expect(button("OK")).toBeUndefined(); expect(button("Close")).toBeUndefined();
    expect(dialog()!.querySelector("a")!.getAttribute("href")).toBe(`https://solscan.io/tx/${sig}`);
    await act(async () => run.broadcast.resolve(Response.json({ signature: sig }))); await advance(1);
    expect(dialog()?.textContent).toContain("Confirming…"); expect(controller.busy).toBe(false);
    status = "success"; await advance(4_000);
    expect(controller.feedback?.phase).toBe("success");
    expect(dialog()?.textContent).toContain("Compound confirmed");
    const statesBefore = fetchMock.mock.calls.filter(([url]) => url === "/api/compound-state").length;
    const refreshBefore = mocks.refresh.mock.calls.length;
    await act(async () => button("OK")!.click()); await advance(1);
    expect(controller.feedback).toBeNull(); expect(dialog()).toBeNull();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/compound-state").length).toBeGreaterThan(statesBefore);
    expect(mocks.refresh.mock.calls.length).toBeGreaterThan(refreshBefore);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/compound-broadcast")).toHaveLength(1);
  });

  it("shows the chain failure with a Solscan link and a Close button", async () => {
    let sig = "";
    const run = await submitWith(() => Response.json({ signature: sig, status: "failed", chainStatus: "failed", state: null }));
    sig = run.signature();
    await act(async () => run.broadcast.resolve(Response.json({ signature: sig }))); await advance(1); await advance(4_000);
    expect(controller.feedback?.phase).toBe("failed");
    expect(dialog()?.textContent).toContain("Compound failed");
    expect(dialog()?.textContent).toContain("failed");
    expect(dialog()!.querySelector("a")!.getAttribute("href")).toBe(`https://solscan.io/tx/${sig}`);
    await act(async () => button("Close")!.click());
    expect(controller.feedback).toBeNull();
  });
});

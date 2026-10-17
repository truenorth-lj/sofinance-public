// @vitest-environment happy-dom
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { useCompoundController } from "./use-compound-controller";
import { compoundAttemptKey, persistCompoundReceipt, type CompoundReceipt } from "@sofinance/engine/compound-attempt";
import { cleanupBatchKey } from "@/lib/compound-cleanup-batch-attempt";
import { compoundHistoryFixture } from "@/lib/test-support/compound-history-fixture";
import { testKeypair } from "@/lib/test-support/send-fixtures";
import type { CompoundAccount } from "@sofinance/engine/compound-types";
const mocks = vi.hoisted(() => ({ sign: vi.fn(), signAll: vi.fn() }));
vi.mock("./wallet-connection", () => ({ useWalletConnection: () => ({ address: wallet, connected: !!wallet,
  signTransaction: mocks.sign, signAllTransactions: supported ? mocks.signAll : undefined }) }));
let wallet: string | undefined, supported: boolean;
let controller: ReturnType<typeof useCompoundController>, root: Root, container: HTMLDivElement;
let fixture: ReturnType<typeof compoundHistoryFixture>, fetchMock: ReturnType<typeof vi.fn>;
let chunkSize: number, result: "pending" | "success" | "manual-review", failures: number, broadcasts: string[];
const receipt = (index: number): CompoundReceipt => ({ wallet: fixture.wallet, positionMint: fixture.state.positionMint,
  sourceSignature: bs58.encode(new Uint8Array(64).fill(9 + index)), compoundAccounts: fixture.attempt.summary.compoundAccounts.map((account, leg) => ({ ...account,
    address: testKeypair(30 + index * 2 + leg).publicKey.toBase58() })) as CompoundReceipt["compoundAccounts"] });
function Harness() {
  const value = useCompoundController({ wallet, positionMint: fixture.state.positionMint, externalBlocked: false });
  useLayoutEffect(() => { controller = value; }); return null;
}
const render = async () => { await act(async () => root.render(createElement(Harness))); await act(async () => { await vi.advanceTimersByTimeAsync(1); }); };
function prepared(accounts: CompoundAccount[]) {
  const transactions = [];
  for (let index = 0; index < accounts.length; index += chunkSize) {
    const sources = accounts.slice(index, index + chunkSize);
    const summary = { operation: "recovery", wallet: fixture.wallet, simulated: true, feeLamports: 5000, sizeBytes: 500,
      expiresAt: Date.now() + 60_000, blockhash: fixture.attempt.summary.blockhash, lastValidBlockHeight: 150,
      compoundAccounts: sources.map(account => ({ ...account, amount: "1", decimals: 6, destination: testKeypair(100).publicKey.toBase58(), sourceLamports: account.rentLamports })) };
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: testKeypair(1).publicKey, recentBlockhash: summary.blockhash,
      instructions: [SystemProgram.transfer({ fromPubkey: testKeypair(1).publicKey, toPubkey: new PublicKey(sources[0]!.address), lamports: 0 })] }).compileToV0Message());
    transactions.push({ summary, permit: "test-permit", unsignedTransaction: Buffer.from(tx.serialize()).toString("base64") });
  }
  return { wallet: fixture.wallet, alreadyClosed: [], transactions };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); window.localStorage.clear();
  fixture = compoundHistoryFixture(); wallet = fixture.wallet; supported = true; chunkSize = 64; result = "success"; failures = 0; broadcasts = [];
  mocks.sign.mockReset(); mocks.signAll.mockReset();
  mocks.sign.mockImplementation(async (tx: VersionedTransaction) => { tx.sign([testKeypair(1)]); return tx; });
  mocks.signAll.mockImplementation(async (txs: VersionedTransaction[]) => txs.map(tx => { tx.sign([testKeypair(1)]); return tx; }));
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url === "/api/compound-state") return Response.json(fixture.state);
    if (url === "/api/compound-cleanup-prepare") return Response.json(prepared(body.compoundAccounts));
    if (url === "/api/compound-cleanup-broadcast") {
      const tx = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64")), signature = bs58.encode(tx.signatures[0]!);
      const record = JSON.parse(window.localStorage.getItem(cleanupBatchKey(fixture.wallet))!);
      expect(record.transactions).toHaveLength(Math.ceil(record.receipts.length * 2 / chunkSize));
      expect(record.transactions.every((item: { signature?: string }) => !!item.signature)).toBe(true);
      broadcasts.push(signature); return Response.json({ signature });
    }
    if (url === "/api/compound-cleanup-confirm") {
      if (failures-- > 0) throw new DOMException("Fetch is aborted", "AbortError");
      return Response.json({ signature: body.signature, status: result, chainStatus: result === "manual-review" ? "unknown" : result });
    }
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock); container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const seed = (count = 3) => { for (let index = 0; index < count; index++) persistCompoundReceipt(window.localStorage, receipt(index)); };
const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(1); }); };
describe("one-approval batch cleanup", () => {
  it("packs three compound groups into one signed transaction and removes all source receipts", async () => {
    seed(); await render(); await act(async () => { await controller.cleanupAll(); }); await flush();
    expect(mocks.sign).toHaveBeenCalledOnce(); expect(mocks.signAll).not.toHaveBeenCalled(); expect(broadcasts).toHaveLength(1);
    expect(controller.receipts).toHaveLength(0); expect(controller.cleanup?.completed).toBe(3); expect(controller.cleanup?.running).toBe(false);
  });
  it("asks signAllTransactions once for multiple chunks, saves every signature before the first send", async () => {
    seed(); chunkSize = 4; await render(); await act(async () => { await controller.cleanupAll(); }); await flush();
    expect(mocks.signAll).toHaveBeenCalledOnce(); expect(mocks.sign).not.toHaveBeenCalled(); expect(broadcasts).toHaveLength(2);
    expect(controller.cleanup?.completed).toBe(3);
  });
  it("starts every signed chunk before waiting for a slow first broadcast", async () => {
    seed(); chunkSize = 2;
    const handler = fetchMock.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    let release!: (response: Response) => void; let first = true, started = 0;
    fetchMock.mockImplementation(async (url, init) => {
      if (url === "/api/compound-cleanup-broadcast") {
        started++;
        if (first) { first = false; return new Promise<Response>(done => { release = done; }); }
      }
      return handler(url, init);
    });
    await render(); let work!: Promise<void>; await act(async () => { work = controller.cleanupAll(); });
    expect(started).toBe(3); expect(mocks.signAll).toHaveBeenCalledOnce();
    const saved = JSON.parse(window.localStorage.getItem(cleanupBatchKey(fixture.wallet))!);
    await act(async () => { release(Response.json({ signature: saved.transactions[0].signature })); await work; }); await flush();
    expect(controller.cleanup?.completed).toBe(3);
  });
  it("stops before signing when wallet cannot batch sign rather than looping prompts", async () => {
    seed(); chunkSize = 2; supported = false; await render(); await act(async () => { await controller.cleanupAll(); });
    expect(mocks.sign).not.toHaveBeenCalled(); expect(mocks.signAll).not.toHaveBeenCalled(); expect(broadcasts).toHaveLength(0);
    expect(controller.error).toContain("does not support one-approval batch signing");
  });
  it("waits four seconds between unchanged pending checks rather than restarting an immediate poll", async () => {
    seed(); result = "pending"; await render(); await act(async () => { await controller.cleanupAll(); }); await flush();
    const count = () => fetchMock.mock.calls.filter(([url]) => url === "/api/compound-cleanup-confirm").length;
    expect(count()).toBe(1);
    const saved = window.localStorage.getItem(cleanupBatchKey(fixture.wallet));
    await act(async () => { await vi.advanceTimersByTimeAsync(3_998); }); expect(count()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2); }); expect(count()).toBe(2);
    expect(window.localStorage.getItem(cleanupBatchKey(fixture.wallet))).toBe(saved);
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); }); expect(count()).toBe(3);
    expect(mocks.sign).toHaveBeenCalledOnce();
  });
  it("retries an aborted confirmation, clears the stale error, and updates all counters", async () => {
    seed(); failures = 1; await render(); await act(async () => { await controller.cleanupAll(); });
    expect(controller.cleanup?.completed).toBe(0); expect(controller.canCompound).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(4_001); });
    expect(controller.cleanup?.completed).toBe(3); expect(controller.receipts).toHaveLength(0); expect(controller.error).toBe("");
    expect(mocks.sign).toHaveBeenCalledOnce();
  });
  it("restores pending signatures after reload and checks them without signing or broadcasting again", async () => {
    seed(); result = "pending"; await render(); await act(async () => { await controller.cleanupAll(); });
    const saved = window.localStorage.getItem(cleanupBatchKey(fixture.wallet));
    await act(async () => root.unmount()); root = createRoot(container); result = "success";
    await render(); await flush();
    expect(saved).not.toBeNull(); expect(controller.cleanup?.completed).toBe(3); expect(controller.receipts).toHaveLength(0);
    expect(mocks.sign).toHaveBeenCalledOnce(); expect(broadcasts).toHaveLength(1);
  });
  it("checks the original signature after unknown broadcast result and never requests a duplicate signature", async () => {
    seed(); const handler = fetchMock.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation(async (url, init) => { if (url === "/api/compound-cleanup-broadcast") throw new DOMException("Fetch is aborted", "AbortError"); return handler(url, init); });
    await render(); await act(async () => { await controller.cleanupAll(); }); await flush();
    expect(controller.cleanup?.completed).toBe(3); expect(mocks.sign).toHaveBeenCalledOnce();
  });
  it("requires explicit requery for manual review, then accepts recovered history", async () => {
    seed(); result = "manual-review"; await render(); await act(async () => { await controller.cleanupAll(); }); await flush();
    expect(controller.canCompound).toBe(false); result = "success";
    await act(async () => { controller.retryReconcile(); });
    expect(controller.cleanup?.completed).toBe(3); expect(controller.receipts).toHaveLength(0);
  });
  it("preserves successful chunks and retries only sources rejected before broadcast", async () => {
    seed(); chunkSize = 2;
    const handler = fetchMock.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>; let rejectFirst = true;
    fetchMock.mockImplementation(async (url, init) => {
      if (url === "/api/compound-cleanup-broadcast" && rejectFirst) { rejectFirst = false; return Response.json({ error: "Not sent", sent: false }, { status: 400 }); }
      return handler(url, init);
    });
    await render(); await act(async () => { await controller.cleanupAll(); }); await flush();
    expect(controller.cleanup?.completed).toBe(2); expect(controller.receipts).toHaveLength(1);
    expect(controller.cleanupBatch?.transactions.filter(tx => tx.unsent)).toHaveLength(1);
    await act(async () => { await controller.cleanupAll(); }); await flush();
    expect(controller.receipts).toHaveLength(0); expect(mocks.signAll).toHaveBeenCalledOnce(); expect(mocks.sign).toHaveBeenCalledOnce();
  });
  it("rejects invalid cryptographic signatures before saving or broadcasting", async () => {
    seed(); mocks.sign.mockImplementation(async (tx: VersionedTransaction) => { tx.signatures[0] = new Uint8Array(64).fill(1); return tx; });
    await render(); await act(async () => { await controller.cleanupAll(); });
    expect(controller.error).toContain("invalid cleanup signature"); expect(broadcasts).toHaveLength(0);
    expect(window.localStorage.getItem(cleanupBatchKey(fixture.wallet))).toBeNull();
  });
  it("rejects reordered wallet return values and broadcasts nothing", async () => {
    seed(); chunkSize = 2;
    mocks.signAll.mockImplementation(async (txs: VersionedTransaction[]) => txs.map(tx => { tx.sign([testKeypair(1)]); return tx; }).reverse());
    await render(); await act(async () => { await controller.cleanupAll(); });
    expect(broadcasts).toHaveLength(0); expect(controller.error).toContain("modified transaction content");
  });
  it("prevents duplicate clicks from opening a second signing prompt", async () => {
    seed(); await render(); await act(async () => { await Promise.all([controller.cleanupAll(), controller.cleanupAll()]); }); await flush();
    expect(mocks.sign).toHaveBeenCalledOnce(); expect(broadcasts).toHaveLength(1);
  });
  it.each(["wallet", "other-tab"])("does not send signatures approved after %s changed", async change => {
    seed(); let resolve!: (tx: VersionedTransaction) => void, signed!: VersionedTransaction;
    mocks.sign.mockImplementation((tx: VersionedTransaction) => { signed = tx; return new Promise(done => { resolve = done; }); });
    await render(); let work!: Promise<void>; await act(async () => { work = controller.cleanupAll(); });
    if (change === "wallet") { wallet = testKeypair(90).publicKey.toBase58(); await render(); }
    else window.localStorage.setItem(compoundAttemptKey(fixture.wallet), "other-tab-record");
    await act(async () => { signed.sign([testKeypair(1)]); resolve(signed); await work; });
    expect(broadcasts).toHaveLength(0); expect(window.localStorage.getItem(cleanupBatchKey(fixture.wallet))).toBeNull();
  });
});

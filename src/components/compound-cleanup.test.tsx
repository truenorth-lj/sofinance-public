// @vitest-environment happy-dom
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { useCompoundController } from "./use-compound-controller";
import { CompoundPanel } from "./compound-panel";
import { compoundAttemptKey, compoundReceiptsKey, persistCompoundAttempt, persistCompoundReceipt, type CompoundReceipt } from "@sofinance/engine/compound-attempt";
import { persistCleanupBatch } from "@/lib/compound-cleanup-batch-attempt";
import { compoundHistoryFixture } from "@/lib/test-support/compound-history-fixture";
import { testKeypair } from "@/lib/test-support/send-fixtures";

const mocks = vi.hoisted(() => ({ sign: vi.fn() }));
vi.mock("./wallet-connection", () => ({ useWalletConnection: () => ({ address: wallet, connected: !!wallet, signTransaction: mocks.sign }) }));
vi.mock("./use-sol-usdc-price", () => ({ useSolUsdcPrices: () => ({ rate: null, usdcUsd: null }) }));
let wallet: string | undefined;
let positionMint: string | undefined;
let controller: ReturnType<typeof useCompoundController>;
let container: HTMLDivElement, root: Root;
let fixture: ReturnType<typeof compoundHistoryFixture>;
let fetchMock: ReturnType<typeof vi.fn>;
let confirmationStatus: "success" | "pending" | "manual-review" | "failed";
let broadcastCount: number;
let broadcastSignatures: string[];
function Harness() {
  const value = useCompoundController({ wallet, positionMint, externalBlocked: false });
  useLayoutEffect(() => { controller = value; });
  return createElement(CompoundPanel, { controller: value });
}
const render = async () => { await act(async () => root.render(createElement(Harness))); await act(async () => { await vi.advanceTimersByTimeAsync(1); }); };
const receipt = (index = 0): CompoundReceipt => ({ wallet: fixture.wallet, positionMint: fixture.state.positionMint,
  sourceSignature: bs58.encode(new Uint8Array(64).fill(9 + index)),
  compoundAccounts: fixture.attempt.summary.compoundAccounts.map((account, leg) => ({ ...account,
    address: testKeypair(30 + index * 2 + leg).publicKey.toBase58() })) as CompoundReceipt["compoundAccounts"] });
function prepared(item: CompoundReceipt) {
  const summary = { operation: "recovery", wallet: fixture.wallet, simulated: true, feeLamports: 5000, sizeBytes: 500,
    expiresAt: Date.now() + 60_000, blockhash: fixture.attempt.summary.blockhash, lastValidBlockHeight: 150,
    compoundAccounts: item.compoundAccounts.map(account => ({ ...account, amount: "1", decimals: 6,
      destination: testKeypair(100).publicKey.toBase58(), sourceLamports: account.rentLamports })) };
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: testKeypair(1).publicKey,
    recentBlockhash: summary.blockhash, instructions: [SystemProgram.transfer({ fromPubkey: testKeypair(1).publicKey,
      toPubkey: new PublicKey(item.compoundAccounts[0].address), lamports: 0 })] }).compileToV0Message());
  return { summary, permit: "synthetic", unsignedTransaction: Buffer.from(tx.serialize()).toString("base64") };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); window.localStorage.clear();
  fixture = compoundHistoryFixture(); wallet = fixture.wallet; positionMint = undefined; broadcastCount = 0; broadcastSignatures = [];
  confirmationStatus = "success";
  mocks.sign.mockReset(); mocks.sign.mockImplementation(async (tx: VersionedTransaction) => { tx.sign([testKeypair(1)]); return tx; });
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    if (url === "/api/compound-state") return Response.json({ ...fixture.state, positionMint: body.positionMint });
    if (url === "/api/compound-recover-prepare") return Response.json(prepared({ ...receipt(), compoundAccounts: body.compoundAccounts }));
    if (url === "/api/compound-recover-broadcast") {
      const tx = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64"));
      const signature = bs58.encode(tx.signatures[0]!); broadcastSignatures.push(signature); broadcastCount++;
      // The signed attempt must already be durable when sending starts.
      expect(JSON.parse(window.localStorage.getItem(compoundAttemptKey(fixture.wallet))!).signature).toBe(signature);
      return Response.json({ signature });
    }
    if (url === "/api/compound-confirm") return Response.json({ signature: body.attempt.signature, status: confirmationStatus,
      chainStatus: confirmationStatus === "manual-review" ? "unknown" : confirmationStatus, state: null });
    if (url === "/api/compound-recover-discover") return Response.json({ wallet, receipts: [receipt()], nextCursor: null,
      scanned: 2, totalCandidates: 2, incomplete: false, errors: 0 });
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("wallet-wide leftover yield cleanup", () => {
  it("discovers and cleans historical receipts without a selected NFT or local records", async () => {
    await render(); expect(controller.receipts).toHaveLength(0);
    await act(async () => { await controller.scanWallet(); });
    expect(controller.receipts).toHaveLength(1); expect(controller.scan.scanned).toBe(2);
    expect(container.textContent).toContain("Wallet scan complete");
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/compound-state")).toBe(false);
    await act(async () => { await controller.recover(controller.receipts[0]!); });
    expect(mocks.sign).toHaveBeenCalledOnce(); expect(broadcastCount).toBe(1);
    expect(controller.receipts).toHaveLength(0); expect(controller.cleanup?.completed).toBe(1);
  });
  it("continues bounded scan pages and retries the failing page without claiming complete", async () => {
    let secondPageFails = true;
    const handler = fetchMock.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url !== "/api/compound-recover-discover") return handler(url, init);
      const { cursor } = JSON.parse(String(init?.body));
      return Response.json({ wallet, receipts: [cursor ? receipt(1) : receipt()], nextCursor: cursor && !secondPageFails ? null : "next-page",
        scanned: cursor && secondPageFails ? 0 : 1, totalCandidates: 2, incomplete: !!cursor && secondPageFails, errors: cursor && secondPageFails ? 1 : 0 });
    });
    await render(); await act(async () => { await controller.scanWallet(); });
    expect(controller.scan.cursor).toBe("next-page"); expect(controller.scan.incomplete).toBe(true);
    expect(container.textContent).toContain("Scan incomplete"); expect(controller.receipts).toHaveLength(2);
    secondPageFails = false;
    await act(async () => { await controller.scanWallet(); });
    expect(controller.scan.cursor).toBeNull(); expect(controller.scan.incomplete).toBe(false); expect(controller.scan.scanned).toBe(2);
    expect(controller.receipts).toHaveLength(2); expect(mocks.sign).not.toHaveBeenCalled();
  });
  it("resumes incomplete scans from the server checkpoint without rescanning completed candidates", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      return Response.json({ wallet, receipts: [body.cursor ? receipt(1) : receipt()],
        nextCursor: body.cursor ? null : "after-first-candidate", scanned: 1, totalCandidates: 2,
        incomplete: !body.cursor, errors: body.cursor ? 0 : 1 });
    });
    await render(); await act(async () => { await controller.scanWallet(); });
    expect(controller.scan.scanned).toBe(1); expect(controller.scan.cursor).toBe("after-first-candidate");
    await act(async () => { await controller.scanWallet(); });
    expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body)).cursor).toBe("after-first-candidate");
    expect(controller.scan.scanned).toBe(2); expect(controller.scan.incomplete).toBe(false); expect(controller.scan.cursor).toBeNull();
  });
  it.each(["manual-review", "failed"] as const)("stops the batch after %s and never submits the next pair", async status => {
    persistCompoundReceipt(window.localStorage, receipt()); persistCompoundReceipt(window.localStorage, receipt(1));
    confirmationStatus = status; await render();
    await act(async () => { await controller.recover(controller.receipts[0]!); });
    expect(broadcastCount).toBe(1); expect(controller.receipts).toHaveLength(2); expect(controller.cleanup?.completed).toBe(0);
    expect(controller.cleanup?.running).toBe(false);
    await act(async () => { await controller.recover(controller.receipts[0]!); });
    expect(broadcastCount).toBe(status === "failed" ? 2 : 1);
  });
  it("stops pending confirmation only after its bounded wait and retains the signed attempt", async () => {
    persistCompoundReceipt(window.localStorage, receipt()); persistCompoundReceipt(window.localStorage, receipt(1));
    confirmationStatus = "pending"; await render(); let work!: Promise<void>;
    await act(async () => { work = controller.recover(controller.receipts[0]!); });
    await act(async () => { await vi.advanceTimersByTimeAsync(89_999); });
    expect(controller.cleanup?.running).toBe(true); expect(broadcastCount).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); await work; });
    expect(controller.cleanup?.running).toBe(false); expect(controller.receipts).toHaveLength(2);
    expect(JSON.parse(window.localStorage.getItem(compoundAttemptKey(fixture.wallet))!).signature).toBe(broadcastSignatures[0]);
    await act(async () => { await controller.recover(controller.receipts[0]!); }); expect(broadcastCount).toBe(1);
  });
  it("does not prune a stale receipt unless closed-account proof matches its exact addresses", async () => {
    persistCompoundReceipt(window.localStorage, receipt());
    fetchMock.mockResolvedValue(Response.json({ alreadyClosed: true, wallet, accounts: receipt(1).compoundAccounts.map(account => account.address) }));
    await render(); await act(async () => { await controller.recover(controller.receipts[0]!); });
    expect(controller.receipts).toHaveLength(1); expect(mocks.sign).not.toHaveBeenCalled();
  });
  it("does not sign or overwrite an unresolved saved compound attempt during cleanup", async () => {
    persistCompoundAttempt(window.localStorage, fixture.attempt); confirmationStatus = "pending";
    await render(); await act(async () => { await controller.recover(controller.receipts[0]!); });
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(compoundAttemptKey(fixture.wallet))).toBe(JSON.stringify(fixture.attempt));
  });
  it.each([
    ["prepare", "pending"], ["sign", "pending"], ["prepare", "invalid"], ["sign", "invalid"],
  ] as const)("preserves another tab's %s-time %s record without broadcasting cleanup", async (pauseAt, stored) => {
    persistCompoundAttempt(window.localStorage, fixture.attempt);
    let resolvePrepare!: (response: Response) => void;
    let resolveSign!: (tx: VersionedTransaction) => void; let signed!: VersionedTransaction;
    const handler = fetchMock.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    if (pauseAt === "prepare") {
      fetchMock.mockImplementation((url: string, init?: RequestInit) => url === "/api/compound-recover-prepare"
        ? new Promise<Response>(done => { resolvePrepare = done; }) : handler(url, init));
    } else {
      mocks.sign.mockImplementation((tx: VersionedTransaction) => {
        signed = tx; return new Promise(done => { resolveSign = done; });
      });
    }
    await render(); await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(controller.attemptStatus).toBe("success");
    const originalReceipt = controller.receipts[0]!;
    let recovering!: Promise<void>;
    await act(async () => { recovering = controller.recover(controller.receipts[0]!); });
    const otherAttempt = { ...fixture.attempt, signature: bs58.encode(new Uint8Array(64).fill(77)) };
    const otherRecord = stored === "pending" ? JSON.stringify(otherAttempt) : "{invalid-other-tab-record";
    window.localStorage.setItem(compoundAttemptKey(fixture.wallet), otherRecord);
    await act(async () => {
      if (pauseAt === "prepare") resolvePrepare(Response.json(prepared(originalReceipt)));
      else { signed.sign([testKeypair(1)]); resolveSign(signed); }
      await recovering;
    });
    expect(mocks.sign).toHaveBeenCalledTimes(pauseAt === "prepare" ? 0 : 1);
    expect(broadcastCount).toBe(0);
    expect(window.localStorage.getItem(compoundAttemptKey(fixture.wallet))).toBe(otherRecord);
    expect(controller.receipts).toHaveLength(1);
    expect(controller.recoveryError?.message).toContain("another tab");
    expect(controller.recoveryError?.message).toContain("Reload and verify");
  });
  it("allows cleanup when the same verified prior attempt remains stored through preparation", async () => {
    persistCompoundAttempt(window.localStorage, fixture.attempt);
    let resolvePrepare!: (response: Response) => void;
    const handler = fetchMock.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === "/api/compound-recover-prepare"
      ? new Promise<Response>(done => { resolvePrepare = done; }) : handler(url, init));
    await render(); await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(controller.attemptStatus).toBe("success");
    const originalReceipt = controller.receipts[0]!;
    let recovering!: Promise<void>;
    await act(async () => { recovering = controller.recover(controller.receipts[0]!); });
    await act(async () => { resolvePrepare(Response.json(prepared(originalReceipt))); await recovering; });
    expect(mocks.sign).toHaveBeenCalledOnce(); expect(broadcastCount).toBe(1);
    expect(controller.receipts).toHaveLength(0); expect(controller.cleanup?.completed).toBe(1);
  });
  it("ignores late discovery after wallet switch, including switching back", async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(done => { resolve = done; }));
    await render(); let scanning!: Promise<void>;
    await act(async () => { scanning = controller.scanWallet(); });
    wallet = testKeypair(90).publicKey.toBase58(); await render(); wallet = fixture.wallet; await render();
    await act(async () => { resolve(Response.json({ wallet: fixture.wallet, receipts: [receipt()], nextCursor: null,
      scanned: 2, totalCandidates: 2, incomplete: false, errors: 0 })); await scanning; });
    expect(controller.receipts).toHaveLength(0); expect(window.localStorage.getItem(compoundReceiptsKey(fixture.wallet))).toBeNull();
  });
  it("never broadcasts a signature approved after the panel unmounts", async () => {
    persistCompoundReceipt(window.localStorage, receipt());
    let resolve!: (tx: VersionedTransaction) => void; let signed!: VersionedTransaction;
    mocks.sign.mockImplementation((tx: VersionedTransaction) => { signed = tx; return new Promise(done => { resolve = done; }); });
    await render(); let recovering!: Promise<void>;
    await act(async () => { recovering = controller.recover(controller.receipts[0]!); });
    await act(async () => root.unmount()); root = createRoot(container);
    await act(async () => { signed.sign([testKeypair(1)]); resolve(signed); await recovering; });
    expect(broadcastCount).toBe(0); expect(window.localStorage.getItem(compoundAttemptKey(fixture.wallet))).toBeNull();
  });
  it.each(["prepare", "sign"] as const)("resets operation UI when selected NFT changes during %s", async pauseAt => {
    positionMint = fixture.state.positionMint;
    persistCompoundReceipt(window.localStorage, receipt());
    let resolvePrepare!: (response: Response) => void;
    let resolveSign!: (tx: VersionedTransaction) => void; let signed!: VersionedTransaction;
    if (pauseAt === "prepare") {
      const handler = fetchMock.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
      fetchMock.mockImplementation((url: string, init?: RequestInit) => url === "/api/compound-recover-prepare"
        ? new Promise<Response>(done => { resolvePrepare = done; }) : handler(url, init));
    } else mocks.sign.mockImplementation((tx: VersionedTransaction) => { signed = tx; return new Promise(done => { resolveSign = done; }); });
    await render(); let work!: Promise<void>;
    await act(async () => { work = controller.recover(controller.receipts[0]!); });
    expect(controller.busy).toBe(true);
    positionMint = testKeypair(80).publicKey.toBase58(); await render();
    expect(controller.stage).toBeNull(); expect(controller.cleanup).toBeNull(); expect(controller.busy).toBe(false);
    await act(async () => {
      if (pauseAt === "prepare") resolvePrepare(Response.json(prepared(receipt())));
      else { signed.sign([testKeypair(1)]); resolveSign(signed); }
      await work;
    });
    expect(controller.busy).toBe(false); expect(controller.canCompound).toBe(true); expect(controller.canCleanup).toBe(true);
    expect(broadcastCount).toBe(0);
  });
  it("cancels queued finality wait on NFT change and never starts the next pair", async () => {
    positionMint = fixture.state.positionMint;
    persistCompoundReceipt(window.localStorage, receipt()); persistCompoundReceipt(window.localStorage, receipt(1));
    confirmationStatus = "pending"; await render(); let work!: Promise<void>;
    await act(async () => { work = controller.recover(controller.receipts[0]!); });
    expect(controller.cleanup?.running).toBe(true); expect(broadcastCount).toBe(1);
    positionMint = testKeypair(80).publicKey.toBase58(); await render();
    await act(async () => { await work; });
    expect(controller.stage).toBeNull(); expect(controller.cleanup).toBeNull(); expect(controller.busy).toBe(false);
    expect(controller.canCompound).toBe(true); expect(broadcastCount).toBe(1);
    const confirmations = fetchMock.mock.calls.filter(([url]) => url === "/api/compound-confirm").length;
    await act(async () => { await vi.advanceTimersByTimeAsync(100_000); });
    expect(broadcastCount).toBe(1); expect(controller.busy).toBe(false);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/compound-confirm").length).toBeGreaterThan(confirmations);
  });
  it("never broadcasts a signature approved after a wallet switch", async () => {
    persistCompoundReceipt(window.localStorage, receipt());
    let resolve!: (tx: VersionedTransaction) => void; let signed!: VersionedTransaction;
    mocks.sign.mockImplementation((tx: VersionedTransaction) => { signed = tx; return new Promise(done => { resolve = done; }); });
    await render(); let recovering!: Promise<void>;
    await act(async () => { recovering = controller.recover(controller.receipts[0]!); });
    wallet = testKeypair(90).publicKey.toBase58(); await render();
    await act(async () => { signed.sign([testKeypair(1)]); resolve(signed); await recovering; });
    expect(broadcastCount).toBe(0); expect(controller.wallet).toBe(wallet); expect(controller.cleanup).toBeNull();
    expect(window.localStorage.getItem(compoundAttemptKey(fixture.wallet))).toBeNull();
  });
});


describe("automatic cleanup after a new compound", () => {
  function enableCompound() {
    positionMint = fixture.state.positionMint;
    const handler = fetchMock.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/compound-prepare") {
        const summary = { ...fixture.attempt.summary, simulatedAt: Date.now(), expiresAt: Date.now() + 60_000 };
        const tx = new VersionedTransaction(new TransactionMessage({ payerKey: testKeypair(1).publicKey,
          recentBlockhash: summary.blockhash, instructions: [] }).compileToV0Message());
        return Response.json({ summary, permit: "synthetic", unsignedTransaction: Buffer.from(tx.serialize()).toString("base64") });
      }
      if (url === "/api/compound-broadcast") {
        const body = JSON.parse(String(init?.body));
        const tx = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64"));
        return Response.json({ signature: bs58.encode(tx.signatures[0]!) });
      }
      return handler(url, init);
    });
  }
  it("automatically prompts cleanup only after the initiated compound is verified successful", async () => {
    enableCompound(); await render();
    await act(async () => { controller.compound(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mocks.sign).toHaveBeenCalledTimes(2); expect(broadcastCount).toBe(1);
    expect(controller.receipts).toHaveLength(0); expect(controller.cleanup?.compoundSignature).toBeTruthy();
    expect(container.textContent).toContain("Compound confirmed.");
  });
  it.each([true, false])("shows fresh yield while cleanup awaits signing (confirmation includes state: %s)", async includesState => {
    enableCompound();
    const freshState = { ...fixture.state, fees: { a: "0", b: "2" } };
    const handler = fetchMock.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    let compounded = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/compound-state" && compounded) return Response.json(freshState);
      if (url === "/api/compound-confirm") {
        compounded = true;
        const body = JSON.parse(String(init?.body));
        return Response.json({ signature: body.attempt.signature, status: "success", chainStatus: "success",
          state: includesState ? freshState : null });
      }
      return handler(url, init);
    });
    let rejectCleanup!: (error: Error) => void;
    mocks.sign.mockImplementationOnce(async (tx: VersionedTransaction) => { tx.sign([testKeypair(1)]); return tx; })
      .mockImplementationOnce(() => new Promise<VersionedTransaction>((_resolve, reject) => { rejectCleanup = reject; }));
    const harvest = () => container.querySelector('section[aria-label="Harvest"]')!;
    const freshAmounts = "0 " + fixture.state.mintA.slice(0, 5) + "…" + fixture.state.mintA.slice(-5) +
      " + 0.000002 " + fixture.state.mintB.slice(0, 5) + "…" + fixture.state.mintB.slice(-5);
    await render();
    const previousHarvest = harvest().textContent;
    await act(async () => { controller.compound(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(controller.state?.fees).toEqual(freshState.fees);
    expect(controller.cleanup?.running).toBe(true); expect(controller.stage).toBe("wallet");
    expect(harvest().textContent).not.toBe(previousHarvest);
    expect(harvest().textContent).toContain(freshAmounts);
    expect(controller.preview).toBeNull();
    expect(container.textContent).toContain("Approve cleanup in wallet…");
    expect(container.textContent).toContain("Previous transaction simulation record");
    await act(async () => { rejectCleanup(new Error("User rejected cleanup")); });
    expect(harvest().textContent).toContain(freshAmounts);
    expect(controller.attemptStatus).toBe("success"); expect(controller.receipts).toHaveLength(1);
    expect(broadcastCount).toBe(0); expect(mocks.sign).toHaveBeenCalledTimes(2);
  });
  it("rearms automatic cleanup when a receipt import refreshes history before its callback starts", async () => {
    enableCompound();
    const handler = fetchMock.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === "/api/compound-recover-import"
      ? Promise.resolve(Response.json({ receipt: receipt(1) })) : handler(url, init));
    await render(); await act(async () => { controller.compound(); });
    expect(controller.attemptStatus).toBe("success"); expect(mocks.sign).toHaveBeenCalledOnce();
    // Compound success has scheduled cleanup, but its timer has not fired yet.
    await act(async () => { await controller.importReceipt(receipt(1).sourceSignature); });
    expect(controller.receipts).toHaveLength(2); expect(mocks.sign).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mocks.sign).toHaveBeenCalledTimes(2); expect(broadcastCount).toBe(1);
    expect(controller.receipts).toHaveLength(1); expect(controller.receipts[0]?.sourceSignature).toBe(receipt(1).sourceSignature);
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    expect(mocks.sign).toHaveBeenCalledTimes(2); expect(broadcastCount).toBe(1);
  });
  it("keeps original compound success and recoverable receipt when follow-up signing is rejected", async () => {
    enableCompound();
    mocks.sign.mockImplementationOnce(async (tx: VersionedTransaction) => { tx.sign([testKeypair(1)]); return tx; })
      .mockRejectedValueOnce(new Error("User rejected cleanup"));
    await render(); await act(async () => { controller.compound(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(controller.attempt?.kind).toBe("compound"); expect(controller.attemptStatus).toBe("success");
    expect(controller.receipts).toHaveLength(1); expect(controller.cleanup?.completed).toBe(0); expect(broadcastCount).toBe(0);
    expect(container.textContent).toContain("Compound confirmed.");
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    expect(mocks.sign).toHaveBeenCalledTimes(2);
  });
  it("retries an aborted single-recovery confirmation without stopping the cleanup", async () => {
    persistCompoundReceipt(window.localStorage, receipt());
    const handler = fetchMock.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>; let failures = 1;
    fetchMock.mockImplementation(async (url, init) => {
      if (url === "/api/compound-confirm" && failures-- > 0) throw new DOMException("Fetch is aborted", "AbortError");
      return handler(url, init);
    });
    await render(); let work!: Promise<void>;
    await act(async () => { work = controller.recover(controller.receipts[0]!); });
    expect(controller.cleanup?.running).toBe(true); expect(controller.attemptError).toBe("");
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); await work; });
    expect(controller.cleanup?.completed).toBe(1); expect(controller.receipts).toHaveLength(0); expect(mocks.sign).toHaveBeenCalledOnce();
  });
  it("keeps polling finalized compound metadata until success and clears prior confirmation failures", async () => {
    persistCompoundAttempt(window.localStorage, fixture.attempt);
    const handler = fetchMock.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>; let missing = true;
    fetchMock.mockImplementation(async (url, init) => {
      if (url === "/api/compound-confirm" && missing) {
        const body = JSON.parse(String(init?.body));
        return Response.json({ signature: body.attempt.signature, status: "pending", chainStatus: "success", state: null });
      }
      return handler(url, init);
    });
    await render(); await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(controller.attemptStatus).toBe("pending"); missing = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(4_001); });
    expect(controller.attemptStatus).toBe("success"); expect(controller.attemptError).toBe(""); expect(mocks.sign).not.toHaveBeenCalled();
  });
  it("updates paused recovery counters when finalized history becomes verifiable after the wait budget", async () => {
    persistCompoundReceipt(window.localStorage, receipt());
    const handler = fetchMock.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>; let missing = true;
    fetchMock.mockImplementation(async (url, init) => {
      if (url === "/api/compound-confirm" && missing) {
        const body = JSON.parse(String(init?.body));
        return Response.json({ signature: body.attempt.signature, status: "pending", chainStatus: "success", state: null });
      }
      return handler(url, init);
    });
    await render(); let work!: Promise<void>;
    await act(async () => { work = controller.recover(controller.receipts[0]!); });
    await act(async () => { await vi.advanceTimersByTimeAsync(90_001); await work; });
    expect(controller.cleanup?.running).toBe(false); expect(controller.cleanup?.completed).toBe(0);
    missing = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(4_001); });
    expect(controller.cleanup?.completed).toBe(1); expect(controller.receipts).toHaveLength(0); expect(controller.attemptStatus).toBe("success");
  });
  it("shows new automatic cleanup progress above a previous completed historical batch", async () => {
    const old = receipt(3);
    persistCleanupBatch(window.localStorage, { version: 1, wallet: fixture.wallet, createdAt: Date.now(), receipts: [old],
      alreadyClosed: old.compoundAccounts.map(account => account.address), transactions: [] });
    enableCompound(); await render();
    await act(async () => { controller.compound(); }); await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(controller.cleanup?.compoundSignature).toBeTruthy(); expect(container.textContent).toContain("Compound confirmed.");
  });
  it("does not prompt cleanup on reload even when a historical compound verifies successfully", async () => {
    persistCompoundAttempt(window.localStorage, fixture.attempt);
    await render(); await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    expect(controller.attemptStatus).toBe("success"); expect(controller.receipts).toHaveLength(1);
    expect(mocks.sign).not.toHaveBeenCalled(); expect(broadcastCount).toBe(0);
  });
  it("does not prompt cleanup while a new compound is pending; prompts once after later success", async () => {
    enableCompound(); confirmationStatus = "pending"; await render();
    await act(async () => { controller.compound(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mocks.sign).toHaveBeenCalledOnce(); expect(broadcastCount).toBe(0);
    confirmationStatus = "success";
    await act(async () => { await vi.advanceTimersByTimeAsync(4_001); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mocks.sign).toHaveBeenCalledTimes(2); expect(broadcastCount).toBe(1);
  });
});

it("recovery wait exclusively checks its signature until selection cancellation releases background polling", async () => {
  persistCompoundReceipt(window.localStorage, receipt()); confirmationStatus = "pending";
  await render(); let work!: Promise<void>;
  await act(async () => { work = controller.recover(controller.receipts[0]!); });
  const checks = () => fetchMock.mock.calls.filter(([url]) => url === "/api/compound-confirm");
  expect(checks()).toHaveLength(1);
  const signature = controller.attempt!.signature;
  await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(checks()).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(3_999); }); expect(checks()).toHaveLength(2);
  positionMint = testKeypair(91).publicKey.toBase58();
  await render(); await act(async () => { await work; });
  expect(controller.cleanup?.running ?? false).toBe(false);
  const before = checks().length;
  await act(async () => { await vi.advanceTimersByTimeAsync(4_000); }); expect(checks()).toHaveLength(before + 1);
  expect(checks().every(([, init]) => JSON.parse(String(init?.body)).attempt.signature === signature)).toBe(true);
  expect(JSON.parse(window.localStorage.getItem(compoundAttemptKey(fixture.wallet))!).signature).toBe(signature);
  expect(mocks.sign).toHaveBeenCalledOnce(); expect(broadcastCount).toBe(1);
});

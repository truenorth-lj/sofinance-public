// @vitest-environment happy-dom
// Step 1/2 SOL swap through the shared wallet send: a Phantom-shaped transaction (its ComputeBudget + Lighthouse
// assertions around our instructions) must be found on-chain after the wallet throws, and never re-sent.
import { beforeEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { VersionedTransaction } from "@solana/web3.js";

vi.mock("server-only", () => ({}));
const sentry = vi.hoisted(() => ({ landed: vi.fn() }));
vi.mock("@/lib/sentry/client-tx", () => ({ captureTxClientFailure: vi.fn(), captureTxWalletErrorLanded: sentry.landed }));
vi.mock("@/lib/position-history-refresh", () => ({ notifyPositionHistoryChange: vi.fn() }));
const relay = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/jupiter/browser-relay", () => ({ postWithJupiterRelay: relay.post }));

import { buildTransaction, phantomMainnetReturn, testKeypair, toBase64 } from "@/lib/test-support/send-fixtures";
import { findLandedTransaction, LANDED_EXPIRY_MARGIN_BLOCKS } from "@/lib/tx-landed/lookup";
import { CANCEL_CHECK_PENDING_COPY, cancelCheckKey, getTxNotices, isCancelCheckPending, noticeIdFor, resetCancelChecks, resetTxNotices,
  TxWalletCancelledError, type FindLanded, type TxWallet } from "@/lib/tx-pipeline";
import { readSolSwapAttempt, type SolSwapStorage } from "./sol-swap-attempt-store";
import { loadSolSwapReceipt } from "./sol-swap-receipt-store";
import { reconcileSolSwapStep, runSolSwapStep, solSwapFailureContext, type SolSwapStage } from "./sol-swap-step-client";

const payer = testKeypair(81);
const WALLET = payer.publicKey.toBase58();
const POOL = testKeypair(82).publicKey.toBase58();
const OUTPUT = testKeypair(83).publicKey.toBase58();
const LVBH = 4_000;
const unsigned = buildTransaction({ payer, signWith: [] });
const LANDED_SIG = bs58.encode(new Uint8Array(64).fill(12));

function memoryStorage(): SolSwapStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); }, removeItem: (k) => { map.delete(k); } };
}
function prepareReply() {
  return Response.json({ unsignedTransaction: toBase64(unsigned), permit: "swap-permit", sendPermit: "send-permit", landedPermit: "check-permit", summary: {
    operation: "sol-swap-step", wallet: WALLET, poolId: POOL, requested: "1000000", outputMint: OUTPUT, outputSymbol: "INTCy",
    blockhash: unsigned.message.recentBlockhash, lastValidBlockHeight: LVBH } });
}
/** Phantom on mainnet: re-signs a rebuilt transaction (ComputeBudget + Lighthouse first), broadcasts it, then throws. */
function phantomThatThrowsAfterSending(): TxWallet & { broadcast: VersionedTransaction[] } {
  const broadcast: VersionedTransaction[] = [];
  return {
    address: WALLET, broadcast,
    signTransaction: vi.fn(),
    signAndSendTransaction: vi.fn(async (tx: VersionedTransaction) => {
      const rebuilt = phantomMainnetReturn(tx, testKeypair(84).publicKey); rebuilt.sign([payer]); broadcast.push(rebuilt);
      throw new Error('{"code":400,"message":"Request ce8e2677deadbeef rejected by user"}');
    }),
  };
}
/**
 * The real server lookup against a fake chain holding what the wallet broadcast, with the route's real cutoff:
 * the browser's prepare time minus skew, never later than server now − 300 s (not "everything since 1970").
 */
function chainLookup(history: () => VersionedTransaction[], height = LVBH - 10): FindLanded {
  return async (check) => findLandedTransaction({
    getEpochInfo: async () => ({ blockHeight: height, absoluteSlot: 9_000 }),
    getSignaturesForAddress: async () => history().map((_, i) => ({ signature: i === 0 ? LANDED_SIG : bs58.encode(new Uint8Array(64).fill(40 + i)),
      blockTime: Math.floor(Date.now() / 1000), slot: 1, err: null, memo: null })),
    getTransaction: async (signature: string) => {
      const index = signature === LANDED_SIG ? 0 : -1;
      const tx = history()[index];
      return tx ? { transaction: { message: tx.message }, meta: { err: null, loadedAddresses: null } } : null;
    },
  } as never, { wallet: WALLET, prepared: check.prepared, lastValidBlockHeight: check.lastValidBlockHeight!, checked: check.exclude,
    notBefore: Math.min(Math.floor(Date.now() / 1000) - 300, Math.floor(check.preparedAt / 1000) - 120) }).then((result) =>
    result.status === "pending" ? { status: "unknown" } : result);
}

beforeEach(() => { resetTxNotices(); resetCancelChecks(); sentry.landed.mockReset(); relay.post.mockReset(); relay.post.mockImplementation(async () => prepareReply()); vi.unstubAllGlobals(); });

describe("runSolSwapStep with a Phantom-shaped transaction", () => {
  it("finds the swap on-chain after Phantom sends then throws 400, and tracks it instead of failing or resending", async () => {
    const wallet = phantomThatThrowsAfterSending(); const storage = memoryStorage(); const stages: SolSwapStage[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: "confirmed", delivered: "123456", decimals: 6 })));
    const receipt = await runSolSwapStep({ poolId: POOL, amount: "0.001", requested: "1000000", store: {} as never, timeoutMs: 5_000,
      wallet, setStage: (s) => stages.push(s), current: () => true, storage, sleep: async () => undefined,
      findLanded: chainLookup(() => wallet.broadcast) });
    expect(wallet.signAndSendTransaction).toHaveBeenCalledTimes(1); expect(wallet.signTransaction).not.toHaveBeenCalled();
    expect(stages).toEqual(["swap-preparing", "swap-wallet", "swap-checking", "swap-broadcasting", "swap-pending"]);
    expect(receipt).toMatchObject({ signature: LANDED_SIG, delivered: "123456", decimals: 6 });
    expect(getTxNotices().some((n) => n.title === "Checking Solana…")).toBe(false);
    expect(readSolSwapAttempt(storage, WALLET)).toBeNull();
    // Counted in Sentry with its public context (blockhash, the wallet's code), like the shared pipeline.
    expect(sentry.landed).toHaveBeenCalledWith("swap", { blockhash: unsigned.message.recentBlockhash, walletErrorCode: 400, landedCheck: "landed" });
  });
  it("4001 cancel: throws 'You cancelled in your wallet' at once (no checking stage, nothing saved); silent if nothing landed", async () => {
    const wallet: TxWallet = { address: WALLET, signTransaction: vi.fn(),
      signAndSendTransaction: vi.fn(async () => { throw Object.assign(new Error("User rejected the request."), { code: 4001 }); }) };
    const storage = memoryStorage(); const stages: SolSwapStage[] = [];
    const error = await runSolSwapStep({ poolId: POOL, amount: "0.001", requested: "1000000", store: {} as never, timeoutMs: 5_000,
      wallet, setStage: (s) => stages.push(s), current: () => true, storage,
      findLanded: chainLookup(() => [], LVBH + LANDED_EXPIRY_MARGIN_BLOCKS + 1) }).catch((e) => e);
    expect(error).toBeInstanceOf(TxWalletCancelledError);
    expect(error.message).toBe("You cancelled in your wallet.");
    expect(stages).toEqual(["swap-preparing", "swap-wallet"]);
    expect(storage.map.size).toBe(0);
    expect(solSwapFailureContext(error)).toEqual({ blockhash: unsigned.message.recentBlockhash, walletErrorCode: 4001 });
    // This pool's open (step 1 and 2) waits for the background check; a second step 1 is refused before preparing.
    expect(isCancelCheckPending(cancelCheckKey("open", POOL))).toBe(true);
    relay.post.mockClear();
    await expect(runSolSwapStep({ poolId: POOL, amount: "0.001", requested: "1000000", store: {} as never, timeoutMs: 5_000,
      wallet, setStage: () => {}, current: () => true, storage })).rejects.toThrow(CANCEL_CHECK_PENDING_COPY);
    expect(relay.post).not.toHaveBeenCalled();
    await error.landed; await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getTxNotices()).toEqual([]);
    expect(sentry.landed).not.toHaveBeenCalled();
    expect(isCancelCheckPending(cancelCheckKey("open", POOL))).toBe(false);
  });
  it("4001 after Phantom already broadcast: the background lookup finds the swap and tracks it (success toast + refresh path)", async () => {
    const broadcast: VersionedTransaction[] = [];
    const wallet: TxWallet = { address: WALLET, signTransaction: vi.fn(), signAndSendTransaction: vi.fn(async (tx: VersionedTransaction) => {
      const rebuilt = phantomMainnetReturn(tx, testKeypair(84).publicKey); rebuilt.sign([payer]); broadcast.push(rebuilt);
      throw Object.assign(new Error("User rejected the request."), { code: 4001 });
    }) };
    const storage = memoryStorage();
    const error = await runSolSwapStep({ poolId: POOL, amount: "0.001", requested: "1000000", store: {} as never, timeoutMs: 5_000,
      wallet, setStage: () => {}, current: () => true, storage, findLanded: chainLookup(() => broadcast) }).catch((e) => e);
    expect(error).toBeInstanceOf(TxWalletCancelledError);
    await error.landed; await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getTxNotices()).toMatchObject([{ id: noticeIdFor(LANDED_SIG), flow: "swap", state: "loading", signature: LANDED_SIG,
      watch: { successTitle: "Step 1/2 swap confirmed", lastValidBlockHeight: LVBH } }]);
    expect(sentry.landed).toHaveBeenCalledWith("swap", expect.objectContaining({ walletErrorCode: 4001, landedCheck: "landed", afterCancel: true,
      blockhash: unsigned.message.recentBlockhash }));
    // Saved as this wallet's step 1/2 attempt, like a normal send: before the one-minute hold is released.
    const saved = readSolSwapAttempt(storage, WALLET);
    expect(saved).toMatchObject({ wallet: WALLET, poolId: POOL, signature: LANDED_SIG, outputMint: OUTPUT, lastValidBlockHeight: LVBH });
    expect(isCancelCheckPending(cancelCheckKey("open", POOL))).toBe(false);
    // A retry after the hold never swaps SOL again: step 1 is refused before preparing or asking the wallet.
    relay.post.mockClear();
    await expect(runSolSwapStep({ poolId: POOL, amount: "0.001", requested: "1000000", store: {} as never, timeoutMs: 5_000,
      wallet, setStage: () => {}, current: () => true, storage })).rejects.toThrow("Check the original SOL swap before opening again.");
    expect(relay.post).not.toHaveBeenCalled(); expect(wallet.signAndSendTransaction).toHaveBeenCalledTimes(1);
    // Recovery confirms the saved swap and stores its receipt: the open modal offers "Continue open (2/2)" (step 2 only).
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: "confirmed", delivered: "123456", decimals: 6 })));
    const receipt = await reconcileSolSwapStep(saved!, { storage, current: () => true, sleep: async () => undefined });
    expect(receipt).toMatchObject({ signature: LANDED_SIG, poolId: POOL, delivered: "123456" });
    expect(readSolSwapAttempt(storage, WALLET)).toBeNull();
    expect(loadSolSwapReceipt(storage, WALLET, POOL, Date.now())).toMatchObject({ signature: LANDED_SIG, delivered: "123456", decimals: 6 });
  });
});

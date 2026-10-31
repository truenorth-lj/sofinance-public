// @vitest-environment happy-dom
// Step 1/2 SOL swap through the shared wallet send: a Phantom-shaped transaction (its ComputeBudget + Lighthouse
// assertions around our instructions) must be found on-chain after the wallet throws, and never re-sent.
import { beforeEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { VersionedTransaction } from "@solana/web3.js";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/sentry/client-tx", () => ({ captureTxClientFailure: vi.fn(), captureTxWalletErrorLanded: vi.fn() }));
vi.mock("@/lib/position-history-refresh", () => ({ notifyPositionHistoryChange: vi.fn() }));
const relay = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/jupiter/browser-relay", () => ({ postWithJupiterRelay: relay.post }));

import { buildTransaction, phantomMainnetReturn, testKeypair, toBase64 } from "@/lib/test-support/send-fixtures";
import { findLandedTransaction, LANDED_EXPIRY_MARGIN_BLOCKS } from "@/lib/tx-landed/lookup";
import { getTxNotices, resetTxNotices, TxNotLandedError, type FindLanded, type TxWallet } from "@/lib/tx-pipeline";
import { readSolSwapAttempt, type SolSwapStorage } from "./sol-swap-attempt-store";
import { runSolSwapStep, type SolSwapStage } from "./sol-swap-step-client";

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
  return Response.json({ unsignedTransaction: toBase64(unsigned), permit: "swap-permit", sendPermit: "send-permit", summary: {
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
/** The real server lookup against a fake chain holding what the wallet broadcast. */
function chainLookup(history: () => VersionedTransaction[], height = LVBH - 10): FindLanded {
  return async (check) => findLandedTransaction({
    getBlockHeight: async () => height,
    getSignaturesForAddress: async () => history().map((_, i) => ({ signature: i === 0 ? LANDED_SIG : bs58.encode(new Uint8Array(64).fill(40 + i)),
      blockTime: Math.floor(Date.now() / 1000), slot: 1, err: null, memo: null })),
    getTransaction: async (signature: string) => {
      const index = signature === LANDED_SIG ? 0 : -1;
      const tx = history()[index];
      return tx ? { transaction: { message: tx.message }, meta: { err: null, loadedAddresses: null } } : null;
    },
  } as never, { wallet: WALLET, prepared: check.prepared, lastValidBlockHeight: check.lastValidBlockHeight!, notBefore: 0 }).then((result) =>
    result.status === "pending" ? { status: "unknown" } : result);
}

beforeEach(() => { resetTxNotices(); relay.post.mockReset(); relay.post.mockImplementation(async () => prepareReply()); vi.unstubAllGlobals(); });

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
  });
  it("after expiry with nothing landed: cancelled-safe-to-retry error, no attempt saved", async () => {
    const wallet: TxWallet = { address: WALLET, signTransaction: vi.fn(),
      signAndSendTransaction: vi.fn(async () => { throw Object.assign(new Error("User rejected the request."), { code: 4001 }); }) };
    const storage = memoryStorage();
    const error = await runSolSwapStep({ poolId: POOL, amount: "0.001", requested: "1000000", store: {} as never, timeoutMs: 5_000,
      wallet, setStage: () => {}, current: () => true, storage, findLanded: chainLookup(() => [], LVBH + LANDED_EXPIRY_MARGIN_BLOCKS + 1) }).catch((e) => e);
    expect(error).toBeInstanceOf(TxNotLandedError);
    expect(error.message).toBe("You cancelled in your wallet. We checked Solana and it did not go through. Nothing was sent, safe to retry.");
    expect(storage.map.size).toBe(0);
  });
});

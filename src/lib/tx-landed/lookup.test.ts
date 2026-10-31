// Server-side landed lookup: finds the prepared transaction in the payer's recent history with the shared
// relaxed post-landing matcher; "not-landed" only after the blockhash expired and the scan was complete.
import { describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { PublicKey, TransactionInstruction, VersionedTransaction, type ConfirmedSignatureInfo, type EpochInfo } from "@solana/web3.js";
type SignaturesConfig = { limit?: number; before?: string; minContextSlot?: number };

vi.mock("server-only", () => ({}));

import { appendWalletExtraInstruction, buildTransaction, phantomMainnetReturn, testKeypair } from "@/lib/test-support/send-fixtures";
import { findLandedTransaction, LANDED_CHECK_WINDOW_BLOCKS, LANDED_EXPIRY_MARGIN_BLOCKS, LANDED_MAX_RPC_CALLS_PER_REQUEST,
  LandedCheckWindowClosedError } from "./lookup";

const payer = testKeypair(61);
const WALLET = payer.publicKey.toBase58();
const prepared = buildTransaction({ payer, signWith: [] });
const sig = (n: number) => bs58.encode(new Uint8Array(64).fill(n));
const NOW = 1_800_000_000;
const LVBH = 1_000;
const SLOT = 345_678;
const other = buildTransaction({ payer, blockhash: bs58.encode(new Uint8Array(32).fill(8)), signWith: [] });
const receipt = (tx: VersionedTransaction, err: unknown = null) => ({ transaction: { message: tx.message }, meta: { err, loadedAddresses: null } });

function chain(options: { height?: number; history: { signature: string; blockTime?: number; tx: VersionedTransaction | null; err?: unknown }[] }) {
  return {
    getEpochInfo: vi.fn<(commitment?: string) => Promise<EpochInfo>>(async () => ({ blockHeight: options.height ?? LVBH + LANDED_EXPIRY_MARGIN_BLOCKS + 1, absoluteSlot: SLOT,
      epoch: 1, slotIndex: 1, slotsInEpoch: 432_000, transactionCount: 1 })),
    getSignaturesForAddress: vi.fn<(address: PublicKey, config?: SignaturesConfig, commitment?: string) => Promise<ConfirmedSignatureInfo[]>>(
      async (_address, config) => {
      const start = config?.before ? options.history.findIndex((entry) => entry.signature === config.before) + 1 : 0;
      return options.history.slice(start, start + (config?.limit ?? 1000))
        .map((entry) => ({ signature: entry.signature, blockTime: entry.blockTime ?? NOW, slot: 1, err: null, memo: null }));
    }),
    getTransaction: vi.fn<(signature: string, config?: unknown) => Promise<ReturnType<typeof receipt> | null>>(async (signature) => {
      const entry = options.history.find((item) => item.signature === signature);
      return entry?.tx ? receipt(entry.tx, entry.err ?? null) : null;
    }),
  };
}
const lookup = (connection: ReturnType<typeof chain>, checked?: string[], extra: { deadline?: number; now?: () => number } = {}) =>
  findLandedTransaction(connection as never, { wallet: WALLET, prepared, lastValidBlockHeight: LVBH, notBefore: NOW - 60, checked, ...extra });
const rpcCalls = (connection: ReturnType<typeof chain>) => connection.getEpochInfo.mock.calls.length +
  connection.getSignaturesForAddress.mock.calls.length + connection.getTransaction.mock.calls.length;

describe("findLandedTransaction", () => {
  it("finds the landed transaction even with wallet-added instructions (Phantom ComputeBudget + Lighthouse)", async () => {
    const landed = phantomMainnetReturn(prepared, testKeypair(62).publicKey);
    const connection = chain({ height: LVBH - 50, history: [{ signature: sig(1), tx: other }, { signature: sig(2), tx: landed }] });
    expect(await lookup(connection)).toEqual({ status: "landed", signature: sig(2) });
    // Height and slot from one confirmed read; the scan is pinned to that slot (no lagging provider can answer it).
    expect(connection.getEpochInfo).toHaveBeenCalledWith("confirmed");
    expect(connection.getSignaturesForAddress).toHaveBeenCalledWith(new PublicKey(WALLET), { limit: 25, minContextSlot: SLOT }, "confirmed");
  });
  it("matches an extra instruction from an unlisted program after landing", async () => {
    const extra = new TransactionInstruction({ programId: testKeypair(63).publicKey, keys: [], data: Buffer.from([5]) });
    const connection = chain({ history: [{ signature: sig(3), tx: appendWalletExtraInstruction(prepared, extra) }] });
    expect(await lookup(connection)).toEqual({ status: "landed", signature: sig(3) });
  });
  it("reports a landed transaction that failed on-chain as failed (by signature)", async () => {
    const connection = chain({ history: [{ signature: sig(4), tx: prepared, err: { InstructionError: [0, "Custom"] } }] });
    expect(await lookup(connection)).toEqual({ status: "failed", signature: sig(4) });
  });
  it("is pending (never not-landed) while the blockhash may still land", async () => {
    const connection = chain({ height: LVBH + LANDED_EXPIRY_MARGIN_BLOCKS, history: [{ signature: sig(5), tx: other }] });
    expect(await lookup(connection)).toEqual({ status: "pending", checked: [sig(5)] });
  });
  it("is not-landed only after expiry and a complete scan of the window", async () => {
    const connection = chain({ history: [{ signature: sig(5), tx: other }, { signature: sig(6), tx: other, blockTime: NOW - 3600 }] });
    expect(await lookup(connection)).toEqual({ status: "not-landed" });
    expect(connection.getTransaction).toHaveBeenCalledTimes(1); // stops at the time bound
  });
  it("stays pending when a candidate could not be read, and skips already-checked signatures", async () => {
    const unread = chain({ history: [{ signature: sig(7), tx: null }] });
    expect(await lookup(unread)).toEqual({ status: "pending", checked: [] });
    const connection = chain({ history: [{ signature: sig(5), tx: other }, { signature: sig(8), tx: other }] });
    expect(await lookup(connection, [sig(5)])).toEqual({ status: "not-landed" });
    expect(connection.getTransaction).toHaveBeenCalledTimes(1);
  });
  it("never claims not-landed from a truncated scan (read budget, page limit)", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ signature: sig(100 + i), tx: other }));
    const first = await lookup(chain({ history: many }));
    expect(first.status).toBe("pending");
    const checked = (first as { checked: string[] }).checked;
    expect(checked).toHaveLength(10);
    const deep = Array.from({ length: 80 }, (_, i) => ({ signature: sig(1 + (i % 250)) + String(i), tx: other }));
    const pages = chain({ history: deep });
    expect((await lookup(pages, deep.map((entry) => entry.signature))).status).toBe("pending");
    expect(pages.getSignaturesForAddress).toHaveBeenCalledTimes(2);
  });
  it("makes at most LANDED_MAX_RPC_CALLS_PER_REQUEST RPC calls per request (13), however long the history", async () => {
    expect(LANDED_MAX_RPC_CALLS_PER_REQUEST).toBe(13);
    const many = Array.from({ length: 200 }, (_, i) => ({ signature: sig(1 + (i % 250)) + String(i), tx: other }));
    for (const skip of [[], many.slice(0, 20).map((entry) => entry.signature), many.slice(0, 45).map((entry) => entry.signature)]) {
      const connection = chain({ history: many });
      await lookup(connection, skip);
      expect(rpcCalls(connection)).toBeLessThanOrEqual(LANDED_MAX_RPC_CALLS_PER_REQUEST);
    }
  });
  it("reads height + slot (one getEpochInfo) before scanning", async () => {
    const order: string[] = [];
    const connection = chain({ history: [] });
    const epoch = connection.getEpochInfo.getMockImplementation()!;
    connection.getEpochInfo.mockImplementation(async (...args) => { order.push("epoch"); return epoch(...args); });
    const original = connection.getSignaturesForAddress.getMockImplementation()!;
    connection.getSignaturesForAddress.mockImplementation(async (...args) => { order.push("scan"); return original(...args); });
    expect(await lookup(connection)).toEqual({ status: "not-landed" });
    expect(order).toEqual(["epoch", "scan"]);
  });
  it("provider lag: a node behind the epoch slot (-32016) or a null receipt is pending, never not-landed", async () => {
    const behind = chain({ height: LVBH + 100, history: [] });
    behind.getSignaturesForAddress.mockRejectedValue(new Error("failed to get signatures for address: Minimum context slot has not been reached (-32016)"));
    expect(await lookup(behind)).toEqual({ status: "pending", checked: [] });
    // Signature list from an up-to-date node, receipt read from a node that has not seen it yet.
    const nullRead = chain({ height: LVBH + 100, history: [{ signature: sig(9), tx: null }] });
    expect(await lookup(nullRead)).toEqual({ status: "pending", checked: [] });
    // Other RPC errors are not swallowed (the route answers 502; the browser keeps polling).
    const broken = chain({ history: [] });
    broken.getSignaturesForAddress.mockRejectedValue(new Error("429 Too Many Requests"));
    await expect(lookup(broken)).rejects.toThrow("429");
  });
  it("refuses once the check window closed (height past lastValidBlockHeight + margin + window)", async () => {
    const closed = chain({ height: LVBH + LANDED_EXPIRY_MARGIN_BLOCKS + LANDED_CHECK_WINDOW_BLOCKS + 1, history: [{ signature: sig(5), tx: prepared }] });
    await expect(lookup(closed)).rejects.toBeInstanceOf(LandedCheckWindowClosedError);
    expect(closed.getSignaturesForAddress).not.toHaveBeenCalled();
    const open = chain({ height: LVBH + LANDED_EXPIRY_MARGIN_BLOCKS + LANDED_CHECK_WINDOW_BLOCKS, history: [] });
    expect(await lookup(open)).toEqual({ status: "not-landed" });
  });
  it("stops at its time budget and answers pending", async () => {
    let clock = 0;
    const connection = chain({ history: [{ signature: sig(5), tx: other }, { signature: sig(6), tx: other }] });
    connection.getTransaction.mockImplementation(async () => { clock += 5_000; return receipt(other); });
    expect(await lookup(connection, [], { now: () => clock, deadline: 4_000 })).toEqual({ status: "pending", checked: [sig(5)] });
    expect(connection.getTransaction).toHaveBeenCalledTimes(1);
  });
});

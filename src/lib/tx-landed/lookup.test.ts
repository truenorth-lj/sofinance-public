// Server-side landed lookup: finds the prepared transaction in the payer's recent history with the shared
// relaxed post-landing matcher; "not-landed" only after the blockhash expired and the scan was complete.
import { describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { PublicKey, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";

vi.mock("server-only", () => ({}));

import { appendWalletExtraInstruction, buildTransaction, phantomMainnetReturn, testKeypair } from "@/lib/test-support/send-fixtures";
import { findLandedTransaction, LANDED_EXPIRY_MARGIN_BLOCKS } from "./lookup";

const payer = testKeypair(61);
const WALLET = payer.publicKey.toBase58();
const prepared = buildTransaction({ payer, signWith: [] });
const sig = (n: number) => bs58.encode(new Uint8Array(64).fill(n));
const NOW = 1_800_000_000;
const LVBH = 1_000;
const other = buildTransaction({ payer, blockhash: bs58.encode(new Uint8Array(32).fill(8)), signWith: [] });
const receipt = (tx: VersionedTransaction, err: unknown = null) => ({ transaction: { message: tx.message }, meta: { err, loadedAddresses: null } });

function chain(options: { height?: number; history: { signature: string; blockTime?: number; tx: VersionedTransaction | null; err?: unknown }[] }) {
  return {
    getBlockHeight: vi.fn(async () => options.height ?? LVBH + LANDED_EXPIRY_MARGIN_BLOCKS + 1),
    getSignaturesForAddress: vi.fn(async (_address: PublicKey, config?: { limit?: number; before?: string }) => {
      const start = config?.before ? options.history.findIndex((entry) => entry.signature === config.before) + 1 : 0;
      return options.history.slice(start, start + (config?.limit ?? 1000))
        .map((entry) => ({ signature: entry.signature, blockTime: entry.blockTime ?? NOW, slot: 1, err: null, memo: null }));
    }),
    getTransaction: vi.fn(async (signature: string) => {
      const entry = options.history.find((item) => item.signature === signature);
      return entry?.tx ? receipt(entry.tx, entry.err ?? null) : null;
    }),
  };
}
const lookup = (connection: ReturnType<typeof chain>, checked?: string[]) =>
  findLandedTransaction(connection as never, { wallet: WALLET, prepared, lastValidBlockHeight: LVBH, notBefore: NOW - 60, checked });

describe("findLandedTransaction", () => {
  it("finds the landed transaction even with wallet-added instructions (Phantom ComputeBudget + Lighthouse)", async () => {
    const landed = phantomMainnetReturn(prepared, testKeypair(62).publicKey);
    const connection = chain({ height: LVBH - 50, history: [{ signature: sig(1), tx: other }, { signature: sig(2), tx: landed }] });
    expect(await lookup(connection)).toEqual({ status: "landed", signature: sig(2) });
    expect(connection.getSignaturesForAddress).toHaveBeenCalledWith(new PublicKey(WALLET), { limit: 25 }, "confirmed");
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
    expect(checked).toHaveLength(12);
    const deep = Array.from({ length: 80 }, (_, i) => ({ signature: sig(1 + (i % 250)) + String(i), tx: other }));
    const pages = chain({ history: deep });
    expect((await lookup(pages, deep.map((entry) => entry.signature))).status).toBe("pending");
    expect(pages.getSignaturesForAddress).toHaveBeenCalledTimes(3);
  });
  it("reads the block height before scanning", async () => {
    const order: string[] = [];
    const connection = chain({ history: [] });
    connection.getBlockHeight.mockImplementation(async () => { order.push("height"); return LVBH + 100; });
    const original = connection.getSignaturesForAddress.getMockImplementation()!;
    connection.getSignaturesForAddress.mockImplementation(async (...args) => { order.push("scan"); return original(...args); });
    expect(await lookup(connection)).toEqual({ status: "not-landed" });
    expect(order).toEqual(["height", "scan"]);
  });
});

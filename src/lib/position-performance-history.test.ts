import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import {
  HISTORY_BATCH_SIZE,
  fetchParsedTransactionsBatched,
  fetchPositionHistoryTransactions,
  mapInBatches,
  mergeHistorySignatures,
  toChronological,
} from "./position-performance-history";

const SIG_A = "5".repeat(88);
const SIG_B = "4".repeat(88);
const SIG_C = "3".repeat(88);
const ADDRESS = new PublicKey("11111111111111111111111111111111");

describe("mapInBatches", () => {
  it("never exceeds the concurrency cap", async () => {
    let current = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    const out = await mapInBatches(items, 4, async (item) => {
      current += 1;
      peak = Math.max(peak, current);
      await Promise.resolve();
      current -= 1;
      return item * 2;
    });
    expect(out).toEqual(items.map((n) => n * 2));
    expect(peak).toBeLessThanOrEqual(4);
    expect(HISTORY_BATCH_SIZE).toBe(8);
  });
});

describe("fetchParsedTransactionsBatched", () => {
  it("skips failed signatures and preserves successful parsed txs", async () => {
    const getParsedTransaction = vi.fn(async (signature: string) => {
      if (signature === SIG_B) return null;
      return {
        slot: 10,
        blockTime: 11,
        meta: { err: null, logMessages: [`log:${signature.slice(0, 1)}`] },
        transaction: { signatures: [signature], message: {} },
      };
    });
    const items = await fetchParsedTransactionsBatched(
      { getParsedTransaction, getSignaturesForAddress: vi.fn() } as never,
      [
        { signature: SIG_A, slot: 1, blockTime: 2, err: null },
        { signature: SIG_B, slot: 2, blockTime: 3, err: null },
        { signature: SIG_C, slot: 3, blockTime: 4, err: "failed" },
      ],
      2,
    );
    expect(items.map((item) => item.signature)).toEqual([SIG_A]);
    expect(getParsedTransaction).toHaveBeenCalledTimes(2);
    expect(getParsedTransaction).not.toHaveBeenCalledWith(SIG_C, expect.anything());
  });

  it("swallows web3.js validation errors and retries the tx on the fallback RPC", async () => {
    const validation = new Error(
      "At path: meta.innerInstructions.0.instructions.0 -- Expected the value to satisfy a union of type | type",
    );
    const primary = vi.fn(async () => {
      throw validation;
    });
    const fallback = vi.fn(async () => ({
      slot: 10,
      blockTime: 11,
      meta: { err: null, logMessages: ["fallback-logs"] },
      transaction: { signatures: [SIG_A], message: {} },
    }));
    const items = await fetchParsedTransactionsBatched(
      { getParsedTransaction: primary, getSignaturesForAddress: vi.fn() } as never,
      [{ signature: SIG_A, slot: 1, blockTime: 2, err: null }],
      {
        primaryProvider: "default",
        fallback: { getParsedTransaction: fallback, getSignaturesForAddress: vi.fn() } as never,
      },
    );
    expect(items).toEqual([
      expect.objectContaining({ signature: SIG_A, logMessages: ["fallback-logs"], servedBy: "default" }),
    ]);
    expect(primary).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledOnce();
  });
});

describe("fetchPositionHistoryTransactions", () => {
  it("lists with getSignaturesForAddress and parses with batched getParsedTransaction", async () => {
    const getSignaturesForAddress = vi.fn(async () => []);
    const result = await fetchPositionHistoryTransactions({
      address: ADDRESS,
      maxSignatures: 10,
      provider: "default",
      connection: { getSignaturesForAddress, getParsedTransaction: vi.fn() } as never,
    });
    expect(getSignaturesForAddress).toHaveBeenCalledWith(ADDRESS, { limit: 10 }, "confirmed");
    expect(result.metric).toEqual({
      txCount: 0, elapsedMs: expect.any(Number), provider: "default",
      source: "getParsedTransactionBatch", defaultTxCount: 0, fallbackReasons: [],
    });
  });

  it("parses on the fallback connection first and the primary second", async () => {
    const listed = [{ signature: SIG_A, slot: 2, blockTime: 2, err: null }, { signature: SIG_B, slot: 1, blockTime: 1, err: null }];
    const parsed = (signature: string, logs: string) => ({ slot: 1, blockTime: 1,
      meta: { err: null, logMessages: [logs] }, transaction: { signatures: [signature], message: {} } });
    const fallbackParsed = vi.fn(async (signature: string) => (signature === SIG_A ? parsed(signature, "fallback") : null));
    const primaryParsed = vi.fn(async (signature: string) => parsed(signature, "primary"));
    const result = await fetchPositionHistoryTransactions({
      address: ADDRESS,
      maxSignatures: 10,
      provider: "default",
      connection: { getSignaturesForAddress: vi.fn(async () => listed), getParsedTransaction: primaryParsed } as never,
      fallbackConnection: { getSignaturesForAddress: vi.fn(), getParsedTransaction: fallbackParsed } as never,
    });
    expect(result.items.map((item) => [item.signature, item.logMessages])).toEqual([[SIG_A, ["fallback"]], [SIG_B, ["primary"]]]);
    expect(primaryParsed).not.toHaveBeenCalledWith(SIG_A, expect.anything());
    expect(result.metric).toMatchObject({ provider: "default", defaultTxCount: 2, txCount: 2 });
  });

  it("marks truncated when the page is full", async () => {
    const getSignaturesForAddress = vi.fn(async () =>
      Array.from({ length: 3 }, (_, i) => ({
        signature: `${SIG_A.slice(0, 80)}${String(i).padStart(8, "0")}`,
        slot: i,
        blockTime: i,
        err: null,
      })),
    );
    const result = await fetchPositionHistoryTransactions({
      address: ADDRESS,
      maxSignatures: 3,
      provider: "default",
      connection: {
        getSignaturesForAddress,
        getParsedTransaction: vi.fn(async () => null),
      } as never,
    });
    expect(result.truncated).toBe(true);
    expect(result.signatureCount).toBe(3);
  });
});

describe("mergeHistorySignatures", () => {
  it("unions by signature, newest first, and caps the page", () => {
    const merged = mergeHistorySignatures(
      [{ signature: SIG_A, slot: 9, blockTime: 9 }],
      [
        { signature: SIG_A, slot: 9, blockTime: 9 },
        { signature: SIG_B, slot: 3, blockTime: 3 },
        { signature: SIG_C, slot: 8, blockTime: 8 },
      ],
      2,
    );
    expect(merged.map((item) => item.signature)).toEqual([SIG_A, SIG_C]);
  });
});

describe("toChronological", () => {
  it("orders by slot then blockTime", () => {
    const ordered = toChronological([
      { signature: "c", slot: 3, blockTime: 1, err: null, logMessages: [] },
      { signature: "a", slot: 1, blockTime: 9, err: null, logMessages: [] },
      { signature: "b", slot: 2, blockTime: 1, err: null, logMessages: [] },
    ]);
    expect(ordered.map((item) => item.signature)).toEqual(["a", "b", "c"]);
  });
});

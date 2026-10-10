import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import {
  HISTORY_BATCH_SIZE,
  fetchParsedTransactionsBatched,
  fetchPositionHistoryTransactions,
  mapInBatches,
  mergeHistorySignatures,
  parseHistoryTxCandidate,
  toChronological,
  unwrapTransactionsForAddressResult,
} from "./position-performance-history";

const SIG_A = "5".repeat(88);
const SIG_B = "4".repeat(88);
const SIG_C = "3".repeat(88);
const ADDRESS = new PublicKey("11111111111111111111111111111111");

/** Live Solami getTransactionsForAddress envelope (transactionDetails: "signatures"). */
const liveSignaturesEnvelope = {
  result: {
    data: [
      {
        blockTime: 1_700_000_000,
        confirmationStatus: "finalized",
        err: null,
        memo: null,
        signature: SIG_A,
        slot: 381_234_567,
        transactionIndex: 12,
      },
    ],
    paginationToken: "381234567:12",
  },
};

const fullParsedRow = {
  signature: SIG_A,
  slot: 42,
  blockTime: 1_700_000_000,
  err: null,
  meta: {
    err: null,
    logMessages: ["Program log: Instruction: IncreaseLiquidity"],
  },
  transaction: { signatures: [SIG_A] },
};

describe("unwrapTransactionsForAddressResult", () => {
  it("reads the live Solami { result: { data, paginationToken } } signatures envelope", () => {
    const parsed = unwrapTransactionsForAddressResult(liveSignaturesEnvelope);
    expect(parsed.paginationToken).toBe("381234567:12");
    expect(parsed.rows).toEqual(liveSignaturesEnvelope.result.data);
    expect(parsed.rows[0]).toEqual({
      blockTime: 1_700_000_000,
      confirmationStatus: "finalized",
      err: null,
      memo: null,
      signature: SIG_A,
      slot: 381_234_567,
      transactionIndex: 12,
    });
  });

  it("reads a Triton/Solami { data, paginationToken } envelope", () => {
    const parsed = unwrapTransactionsForAddressResult({
      data: [fullParsedRow],
      paginationToken: "42:0",
    });
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.paginationToken).toBe("42:0");
  });

  it("reads a JSON-RPC { result: { data } } envelope and snake_case cursor", () => {
    const parsed = unwrapTransactionsForAddressResult({
      jsonrpc: "2.0",
      result: { data: [fullParsedRow], pagination_token: "99:1" },
    });
    expect(parsed.paginationToken).toBe("99:1");
    expect(parsed.rows[0]).toEqual(fullParsedRow);
  });

  it("reads nested value.data and a bare array", () => {
    expect(unwrapTransactionsForAddressResult({ value: { data: [1, 2] } }).rows).toEqual([1, 2]);
    expect(unwrapTransactionsForAddressResult([fullParsedRow]).rows).toHaveLength(1);
  });

  it("throws when the RPC envelope carries an error", () => {
    expect(() => unwrapTransactionsForAddressResult({ error: { message: "method not found" } })).toThrow(
      "method not found",
    );
  });

  it("returns empty rows for unknown objects instead of throwing", () => {
    expect(unwrapTransactionsForAddressResult({ unexpected: true })).toEqual({
      rows: [],
      paginationToken: null,
    });
  });
});

describe("parseHistoryTxCandidate", () => {
  it("reads a live signatures-only row (blockTime, confirmationStatus, err, memo, signature, slot, transactionIndex)", () => {
    expect(parseHistoryTxCandidate(liveSignaturesEnvelope.result.data[0])).toEqual({
      signature: SIG_A,
      slot: 381_234_567,
      blockTime: 1_700_000_000,
      err: null,
      logMessages: null,
    });
  });

  it("reads a full parsed transaction with top-level signature + meta.logs", () => {
    expect(parseHistoryTxCandidate(fullParsedRow)).toEqual({
      signature: SIG_A,
      slot: 42,
      blockTime: 1_700_000_000,
      err: null,
      logMessages: ["Program log: Instruction: IncreaseLiquidity"],
    });
  });

  it("falls back to transaction.signatures[0] and nested meta", () => {
    expect(
      parseHistoryTxCandidate({
        slot: "7",
        block_time: "99",
        transaction: {
          signatures: [SIG_B],
          meta: { err: { InstructionError: [0, "Custom"] }, logMessages: ["fail"] },
        },
      }),
    ).toEqual({
      signature: SIG_B,
      slot: 7,
      blockTime: 99,
      err: { InstructionError: [0, "Custom"] },
      logMessages: ["fail"],
    });
  });

  it("returns null when no signature can be found", () => {
    expect(parseHistoryTxCandidate({ slot: 1, meta: { logMessages: ["x"] } })).toBeNull();
    expect(parseHistoryTxCandidate(null)).toBeNull();
    expect(parseHistoryTxCandidate("nope")).toBeNull();
  });
});

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
        primaryProvider: "solami",
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
  it("uses getTransactionsForAddress on Solami with the live signatures params and envelope", async () => {
    const customRpc = vi.fn(async () => liveSignaturesEnvelope);
    const getSignaturesForAddress = vi.fn();
    const getParsedTransaction = vi.fn(async () => ({
      slot: 381_234_567,
      blockTime: 1_700_000_000,
      meta: { err: null, logMessages: ["Program log: Instruction: IncreaseLiquidity"] },
      transaction: { signatures: [SIG_A], message: {} },
    }));
    let t = 1_000;
    const result = await fetchPositionHistoryTransactions({
      address: ADDRESS,
      maxSignatures: 100,
      provider: "solami",
      customRpc,
      connection: { getSignaturesForAddress, getParsedTransaction } as never,
      nowMs: () => {
        t += 25;
        return t;
      },
    });
    expect(customRpc).toHaveBeenCalledWith("getTransactionsForAddress", [
      ADDRESS.toBase58(),
      { limit: 100, transactionDetails: "signatures" },
    ]);
    expect(getSignaturesForAddress).not.toHaveBeenCalled();
    expect(getParsedTransaction).toHaveBeenCalledOnce();
    expect(result.items[0]?.signature).toBe(SIG_A);
    expect(result.items[0]?.logMessages).toEqual(["Program log: Instruction: IncreaseLiquidity"]);
    expect(result.metric).toMatchObject({
      txCount: 1,
      provider: "solami",
      source: "getTransactionsForAddress",
    });
    expect(result.metric.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("fills missing logs via a batched getParsedTransaction after Solami returns signatures only", async () => {
    const customRpc = vi.fn(async () => ({
      data: [{ signature: SIG_A, slot: 9, blockTime: 8, err: null }],
    }));
    const getParsedTransaction = vi.fn(async () => ({
      slot: 9,
      blockTime: 8,
      meta: { err: null, logMessages: ["filled"] },
      transaction: { signatures: [SIG_A], message: {} },
    }));
    const result = await fetchPositionHistoryTransactions({
      address: ADDRESS,
      maxSignatures: 10,
      provider: "solami",
      customRpc,
      connection: { getSignaturesForAddress: vi.fn(), getParsedTransaction } as never,
    });
    expect(getParsedTransaction).toHaveBeenCalledOnce();
    expect(result.items[0]?.logMessages).toEqual(["filled"]);
    expect(result.metric.source).toBe("getTransactionsForAddress");
  });

  it("falls back to batched getParsedTransaction when Solami's custom method fails", async () => {
    const customRpc = vi.fn(async () => {
      throw new Error("method not found");
    });
    const getSignaturesForAddress = vi.fn(async () => [
      { signature: SIG_A, slot: 1, blockTime: 2, err: null },
      { signature: SIG_B, slot: 2, blockTime: 3, err: null },
    ]);
    const getParsedTransaction = vi.fn(async (signature: string) => ({
      slot: 1,
      blockTime: 2,
      meta: { err: null, logMessages: [signature] },
      transaction: { signatures: [signature], message: {} },
    }));
    const result = await fetchPositionHistoryTransactions({
      address: ADDRESS,
      maxSignatures: 50,
      provider: "solami",
      customRpc,
      connection: { getSignaturesForAddress, getParsedTransaction } as never,
    });
    expect(getSignaturesForAddress).toHaveBeenCalledOnce();
    expect(getParsedTransaction).toHaveBeenCalledTimes(2);
    expect(result.metric).toMatchObject({
      txCount: 2,
      provider: "solami",
      source: "getParsedTransactionBatch",
    });
    expect(result.truncated).toBe(false);
  });

  it("never calls getTransactionsForAddress on the default provider", async () => {
    const customRpc = vi.fn();
    const getSignaturesForAddress = vi.fn(async () => []);
    const result = await fetchPositionHistoryTransactions({
      address: ADDRESS,
      maxSignatures: 10,
      provider: "default",
      customRpc,
      connection: { getSignaturesForAddress, getParsedTransaction: vi.fn() } as never,
    });
    expect(customRpc).not.toHaveBeenCalled();
    expect(result.metric.provider).toBe("default");
    expect(result.metric.source).toBe("getParsedTransactionBatch");
    expect(result.metric.txCount).toBe(0);
  });

  it("falls back to the default RPC when Solami returns an empty signatures page", async () => {
    const customRpc = vi.fn(async () => ({ result: { data: [], paginationToken: null } }));
    const solamiParsed = vi.fn();
    const fallbackParsed = vi.fn(async () => ({
      slot: 428_056_506,
      blockTime: 1_782_000_000,
      meta: { err: null, logMessages: ["older"] },
      transaction: { signatures: [SIG_A], message: {} },
    }));
    const fallbackSigs = vi.fn(async () => [
      { signature: SIG_A, slot: 428_056_506, blockTime: 1_782_000_000, err: null },
    ]);
    const result = await fetchPositionHistoryTransactions({
      address: ADDRESS,
      maxSignatures: 20,
      provider: "solami",
      customRpc,
      connection: { getSignaturesForAddress: vi.fn(async () => []), getParsedTransaction: solamiParsed } as never,
      fallbackConnection: { getSignaturesForAddress: fallbackSigs, getParsedTransaction: fallbackParsed } as never,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.signature).toBe(SIG_A);
    expect(result.items[0]?.servedBy).toBe("default");
    expect(solamiParsed).not.toHaveBeenCalled();
    expect(result.metric).toMatchObject({
      provider: "default",
      source: "getParsedTransactionBatch",
      solamiTxCount: 0,
      defaultTxCount: 1,
      fallbackReasons: ["solami-empty"],
    });
  });

  it("falls back per tx when Solami getParsedTransaction fails web3.js validation", async () => {
    const customRpc = vi.fn(async () => liveSignaturesEnvelope);
    const solamiParsed = vi.fn(async () => {
      throw new Error(
        "At path: meta.innerInstructions.0.instructions.0 -- Expected the value to satisfy a union of type | type",
      );
    });
    const fallbackParsed = vi.fn(async () => ({
      slot: 381_234_567,
      blockTime: 1_700_000_000,
      meta: { err: null, logMessages: ["from-default"] },
      transaction: { signatures: [SIG_A], message: {} },
    }));
    const result = await fetchPositionHistoryTransactions({
      address: ADDRESS,
      maxSignatures: 10,
      provider: "solami",
      customRpc,
      connection: { getSignaturesForAddress: vi.fn(async () => []), getParsedTransaction: solamiParsed } as never,
      fallbackConnection: {
        getSignaturesForAddress: vi.fn(async () => []),
        getParsedTransaction: fallbackParsed,
      } as never,
    });
    expect(result.items[0]?.logMessages).toEqual(["from-default"]);
    expect(result.items[0]?.servedBy).toBe("default");
    expect(result.metric).toMatchObject({
      provider: "default",
      source: "getTransactionsForAddress",
      solamiTxCount: 0,
      defaultTxCount: 1,
      fallbackReasons: ["solami-parse-error"],
    });
  });

  it("merges recent Solami signatures with older default-RPC history", async () => {
    const customRpc = vi.fn(async () => liveSignaturesEnvelope);
    const solamiParsed = vi.fn(async (signature: string) => ({
      slot: 381_234_567,
      blockTime: 1_700_000_000,
      meta: { err: null, logMessages: [`solami:${signature.slice(0, 1)}`] },
      transaction: { signatures: [signature], message: {} },
    }));
    const fallbackParsed = vi.fn(async (signature: string) => ({
      slot: 100,
      blockTime: 1_650_000_000,
      meta: { err: null, logMessages: [`default:${signature.slice(0, 1)}`] },
      transaction: { signatures: [signature], message: {} },
    }));
    const result = await fetchPositionHistoryTransactions({
      address: ADDRESS,
      maxSignatures: 20,
      provider: "solami",
      customRpc,
      connection: { getSignaturesForAddress: vi.fn(), getParsedTransaction: solamiParsed } as never,
      fallbackConnection: {
        getSignaturesForAddress: vi.fn(async () => [
          { signature: SIG_A, slot: 381_234_567, blockTime: 1_700_000_000, err: null },
          { signature: SIG_B, slot: 100, blockTime: 1_650_000_000, err: null },
        ]),
        getParsedTransaction: fallbackParsed,
      } as never,
    });
    expect(result.items.map((item) => item.signature).sort()).toEqual([SIG_A, SIG_B].sort());
    expect(result.items.find((item) => item.signature === SIG_A)?.servedBy).toBe("solami");
    expect(result.items.find((item) => item.signature === SIG_B)?.servedBy).toBe("default");
    expect(solamiParsed).toHaveBeenCalledWith(SIG_A, expect.anything());
    expect(solamiParsed).not.toHaveBeenCalledWith(SIG_B, expect.anything());
    expect(result.metric).toMatchObject({
      provider: "solami+default",
      source: "getTransactionsForAddress",
      solamiTxCount: 1,
      defaultTxCount: 1,
      fallbackReasons: ["solami-limited-window"],
      txCount: 2,
    });
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

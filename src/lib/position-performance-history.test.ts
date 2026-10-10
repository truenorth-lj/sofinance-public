import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import {
  HISTORY_BATCH_SIZE,
  fetchParsedTransactionsBatched,
  fetchPositionHistoryTransactions,
  mapInBatches,
  parseHistoryTxCandidate,
  toChronological,
  unwrapTransactionsForAddressResult,
} from "./position-performance-history";

const SIG_A = "5".repeat(88);
const SIG_B = "4".repeat(88);
const SIG_C = "3".repeat(88);
const ADDRESS = new PublicKey("11111111111111111111111111111111");

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
});

describe("fetchPositionHistoryTransactions", () => {
  it("uses getTransactionsForAddress on Solami when the method returns full txs", async () => {
    const customRpc = vi.fn(async () => ({ data: [fullParsedRow], paginationToken: null }));
    const getSignaturesForAddress = vi.fn();
    const getParsedTransaction = vi.fn();
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
      expect.objectContaining({
        transactionDetails: "full",
        encoding: "jsonParsed",
        sortOrder: "desc",
        limit: 100,
      }),
    ]);
    expect(getSignaturesForAddress).not.toHaveBeenCalled();
    expect(getParsedTransaction).not.toHaveBeenCalled();
    expect(result.items[0]?.signature).toBe(SIG_A);
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

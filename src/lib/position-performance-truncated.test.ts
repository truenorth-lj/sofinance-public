import { describe, expect, it, vi } from "vitest";
import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import fixture from "./fixtures/position-open-truncated.json";
import { fetchPositionHistoryTransactions } from "./position-performance-history";
import { aggregateCashflowsForPosition, CREATE_PERSONAL_POSITION_DISC, parsePositionCashflowEvents } from "./position-performance-events";

const context = {
  positionMint: "JDkQhE4HtJyghqrdCQYgTb3K3sxRvBDSpr9GdnUn9KBm",
  positionAccount: "wbAC4rK5HVkajS4LDEZcxHc2rt9DjzHDJDBRGfLNeN9",
  poolId: "91LzcuckvQePML9HDtwDbjeTiCdSi2erDXM5AeMJdLyy",
  mintA: "BJnipLGC25HZ6KawVkcsw72MtSfz1KcHK7ttSB8NJyTB",
  mintB: "Hyr9Zu1qim75vzFjbqRZ68j57wGtxAyA7sj2oiU6ztCe",
  vaultA: "2po3aGeWBRhXpoZgNNSFMqxf5AHNz7QM7rGneLYHwVwd",
  vaultB: "6a96mvDwDKcXAAkvBWMhDRyoeABqz3cZa3tqsis4CmoQ",
};

function transaction(): ParsedTransactionWithMeta {
  return JSON.parse(JSON.stringify(fixture), (key, value) => {
    if (key === "programId") return new PublicKey(value);
    if (key === "accounts") return value.map((address: string) => new PublicKey(address));
    return value;
  });
}

describe("position history with truncated opening logs", () => {
  it("recovers the real opening deposit through the history fetch path, excluding the preceding swaps", async () => {
    const tx = transaction();
    const fetched = await fetchPositionHistoryTransactions({
      address: new PublicKey(context.positionAccount), maxSignatures: 100, provider: "default",
      connection: {
        getSignaturesForAddress: vi.fn().mockResolvedValue([{ signature: fixture.transaction.signatures[0], slot: tx.slot, blockTime: tx.blockTime, err: null }]),
        getParsedTransaction: vi.fn().mockResolvedValue(tx),
      },
    });
    const events = fetched.items.flatMap(item => parsePositionCashflowEvents(item.logMessages, item.parsedTransaction, context));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "open", amountA: "1525841", amountB: "15283" });
    const cash = aggregateCashflowsForPosition(events, context.positionMint, context.poolId);
    expect(cash.openCount).toBe(1);
    expect(cash.depositedA).toBe(1525841n);
    expect(cash.depositedB).toBe(15283n);
    expect(fetched.items[0]?.blockTime).toBe(1791595611);
  });

  it("does not recover deposits for a failed transaction, another NFT, or another vault", () => {
    const tx = transaction();
    expect(parsePositionCashflowEvents(tx.meta!.logMessages, tx, { ...context, positionMint: PublicKey.unique().toBase58() })).toEqual([]);
    expect(parsePositionCashflowEvents(tx.meta!.logMessages, tx, { ...context, vaultA: PublicKey.unique().toBase58() })).toEqual([]);
    tx.meta!.err = { InstructionError: [1, "InvalidArgument"] };
    expect(parsePositionCashflowEvents(tx.meta!.logMessages, tx, context)).toEqual([]);
  });

  it("does not double count an opening event already emitted before truncation", () => {
    const tx = transaction();
    const data = Buffer.alloc(160);
    CREATE_PERSONAL_POSITION_DISC.copy(data);
    new PublicKey(context.poolId).toBuffer().copy(data, 8);
    data.writeBigUInt64LE(1525841n, 128);
    data.writeBigUInt64LE(15283n, 136);
    const logs = [`Program data: ${data.toString("base64")}`, "Log truncated"];
    expect(parsePositionCashflowEvents(logs, tx, context)).toHaveLength(1);
  });

  it("requires the actual transfer receipts instead of using the instruction's amount maximum", () => {
    const tx = transaction();
    tx.meta!.innerInstructions = [];
    expect(parsePositionCashflowEvents(tx.meta!.logMessages, tx, context)).toEqual([]);
  });

  it("supports the v2 account layout with its extra metadata account", () => {
    const tx = transaction();
    const ix = tx.transaction.message.instructions[1]!;
    if (!("accounts" in ix)) throw new Error("Expected opening instruction");
    ix.accounts.splice(4, 0, PublicKey.unique());
    ix.accounts.splice(18, 0, PublicKey.unique());
    const data = Buffer.from(bs58.decode(ix.data));
    createHash("sha256").update("global:open_position_v2").digest().subarray(0, 8).copy(data);
    ix.data = bs58.encode(data);
    expect(parsePositionCashflowEvents(tx.meta!.logMessages, tx, context)).toMatchObject([
      { kind: "open", amountA: "1525841", amountB: "15283" },
    ]);
  });
});

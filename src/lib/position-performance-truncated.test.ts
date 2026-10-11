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
    expect(() => parsePositionCashflowEvents(tx.meta!.logMessages, tx, context)).toThrow(/transfer receipts are unavailable/);
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

// Replay the production SDK's actual account/data layouts with truncated logs.
describe("truncated add / collect / withdrawal history", () => {
  function operation(kind: "increase" | "decrease", liquidity: number) {
    const tx = transaction();
    const open = tx.transaction.message.instructions[1]!;
    if (!("accounts" in open)) throw new Error("Expected opening instruction");
    const a = open.accounts;
    const accounts = kind === "increase"
      ? [a[0]!, a[3]!, a[4]!, a[5]!, a[8]!, a[6]!, a[7]!, a[9]!, a[10]!, a[11]!, a[12]!, a[15]!, a[17]!, a[18]!, a[19]!]
      : [a[0]!, a[3]!, a[8]!, a[4]!, a[5]!, a[11]!, a[12]!, a[6]!, a[7]!, a[9]!, a[10]!, a[15]!, a[17]!, PublicKey.unique(), a[18]!, a[19]!];
    const data = Buffer.alloc(kind === "increase" ? 42 : 40);
    createHash("sha256").update(`global:${kind}_liquidity_v2`).digest().subarray(0, 8).copy(data);
    data.writeBigUInt64LE(BigInt(liquidity), 8);
    data.writeBigUInt64LE(2000000n, 24);
    data.writeBigUInt64LE(20000n, 32);
    tx.transaction.message.instructions[1] = { programId: open.programId, accounts, data: bs58.encode(data) };
    if (kind === "decrease") for (const ix of tx.meta!.innerInstructions![1]!.instructions) {
      if (!("parsed" in ix)) continue;
      const info = ix.parsed.info;
      [info.source, info.destination] = [info.destination, info.source];
      info.authority = context.poolId;
    }
    return tx;
  }

  it("recovers add-liquidity deposits from actual transfers, excluding swaps and amount maxima", () => {
    const tx = operation("increase", 5);
    const events = parsePositionCashflowEvents(tx.meta!.logMessages, tx, context);
    expect(events).toMatchObject([{ kind: "increase", amountA: "1525841", amountB: "15283" }]);
    const cash = aggregateCashflowsForPosition(events, context.positionMint, context.poolId);
    expect(cash.increaseCount).toBe(1);
    expect(cash.depositedA).toBe(1525841n);
  });

  it("recovers fee-only collection because zero liquidity proves no principal was removed", () => {
    const tx = operation("decrease", 0);
    const events = parsePositionCashflowEvents(tx.meta!.logMessages, tx, context);
    expect(events).toMatchObject([{ kind: "decrease", principalA: "0", principalB: "0", feeA: "1525841", feeB: "15283" }]);
    const cash = aggregateCashflowsForPosition(events, context.positionMint, context.poolId);
    expect(cash.feesCollectedA).toBe(1525841n);
    expect(cash.withdrawnPrincipalA).toBe(0n);
  });

  function encodedEvent(kind: "increase" | "decrease", liquidity = 5) {
    const data = Buffer.alloc(kind === "increase" ? 88 : 128);
    createHash("sha256").update(`event:${kind === "increase" ? "IncreaseLiquidityEvent" : "DecreaseLiquidityEvent"}`).digest().subarray(0, 8).copy(data);
    new PublicKey(context.positionMint).toBuffer().copy(data, 8);
    data.writeBigUInt64LE(BigInt(liquidity), 40);
    data.writeBigUInt64LE(1525841n, 56);
    data.writeBigUInt64LE(15283n, 64);
    return `Program data: ${data.toString("base64")}`;
  }

  it("does not double count completed add / withdrawal events before truncation", () => {
    for (const kind of ["increase", "decrease"] as const) {
      const tx = operation(kind, 5);
      tx.meta!.logMessages = [encodedEvent(kind), "Log truncated"];
      expect(parsePositionCashflowEvents(tx.meta!.logMessages, tx, context)).toHaveLength(1);
    }
  });

  it("handles a compound transaction containing both fee collection and reinvestment", () => {
    const tx = operation("decrease", 0), add = operation("increase", 5);
    tx.transaction.message.instructions.push(add.transaction.message.instructions[1]!);
    tx.meta!.innerInstructions!.push({ ...add.meta!.innerInstructions![1]!, index: 2 });
    const events = parsePositionCashflowEvents(tx.meta!.logMessages, tx, context);
    expect(events.map(event => event.kind)).toEqual(["decrease", "increase"]);
    const cash = aggregateCashflowsForPosition(events, context.positionMint, context.poolId);
    expect(cash.depositedA).toBe(1525841n);
    expect(cash.feesCollectedA).toBe(1525841n);
    expect(cash.withdrawnPrincipalA).toBe(0n);
    tx.meta!.logMessages = [encodedEvent("decrease", 0), "Log truncated"];
    expect(parsePositionCashflowEvents(tx.meta!.logMessages, tx, context)).toHaveLength(2);
  });

  it("recovers a second add after the first add event was already recorded", () => {
    const tx = operation("increase", 5), second = operation("increase", 7);
    tx.transaction.message.instructions.push(second.transaction.message.instructions[1]!);
    tx.meta!.innerInstructions!.push({ ...second.meta!.innerInstructions![1]!, index: 2 });
    tx.meta!.logMessages = [encodedEvent("increase"), "Log truncated"];
    const cash = aggregateCashflowsForPosition(parsePositionCashflowEvents(tx.meta!.logMessages, tx, context), context.positionMint, context.poolId);
    expect(cash.increaseCount).toBe(2);
    expect(cash.depositedA).toBe(3051682n);
  });

  it("excludes reward-vault transfers even when they use a pool token mint", () => {
    const tx = operation("decrease", 0);
    const reward = structuredClone(fixture.meta.innerInstructions[1]!.instructions[0]!);
    reward.parsed.info.source = PublicKey.unique().toBase58();
    reward.parsed.info.authority = context.poolId;
    tx.meta!.innerInstructions![1]!.instructions.push({ ...reward, programId: new PublicKey(reward.programId) });
    expect(parsePositionCashflowEvents(tx.meta!.logMessages, tx, context)[0]).toMatchObject({ feeA: "1525841" });
  });

  it("supports one-sided adds without manufacturing the unused side from amount maxima", () => {
    const tx = operation("increase", 5);
    tx.meta!.innerInstructions![1]!.instructions.pop();
    expect(parsePositionCashflowEvents(tx.meta!.logMessages, tx, context)[0]).toMatchObject({ amountA: "1525841", amountB: "0" });
  });

  it("fails clearly when transfer receipts are missing or the transfer authority is wrong", () => {
    const tx = operation("increase", 5);
    tx.meta!.innerInstructions = [];
    expect(() => parsePositionCashflowEvents(tx.meta!.logMessages, tx, context)).toThrow(/receipts are unavailable/);
    const collect = operation("decrease", 0);
    const ix = collect.meta!.innerInstructions![1]!.instructions[0]!;
    if (!("parsed" in ix)) throw new Error("Expected transfer");
    ix.parsed.info.authority = PublicKey.unique().toBase58();
    expect(() => parsePositionCashflowEvents(collect.meta!.logMessages, collect, context)).toThrow(/amounts are unavailable/);
  });

  it("recovers the principal/fee split from a scoped calculation event that survived truncation", () => {
    const tx = operation("decrease", 5);
    const calculation = Buffer.alloc(92);
    createHash("sha256").update("event:LiquidityCalculateEvent").digest().subarray(0, 8).copy(calculation);
    calculation.writeBigUInt64LE(1525000n, 44);
    calculation.writeBigUInt64LE(15000n, 52);
    calculation.writeBigUInt64LE(841n, 60);
    calculation.writeBigUInt64LE(283n, 68);
    const swapProgram = tx.transaction.message.instructions[0]!.programId.toBase58();
    const clmmProgram = tx.transaction.message.instructions[1]!.programId.toBase58();
    tx.meta!.logMessages = [`Program ${swapProgram} invoke [1]`, `Program ${swapProgram} success`,
      `Program ${clmmProgram} invoke [1]`, `Program data: ${calculation.toString("base64")}`, "Log truncated"];
    expect(parsePositionCashflowEvents(tx.meta!.logMessages, tx, context)).toMatchObject([
      { kind: "decrease", principalA: "1525000", principalB: "15000", feeA: "841", feeB: "283" },
    ]);
    // The same payload from another program must never authorize a split.
    tx.meta!.logMessages = [`Program ${swapProgram} invoke [1]`, `Program data: ${calculation.toString("base64")}`, "Log truncated"];
    expect(() => parsePositionCashflowEvents(tx.meta!.logMessages, tx, context)).toThrow(/principal.*fees.*unavailable/i);
  });

  it("refuses a principal withdrawal without its event instead of silently reporting zero withdrawal/fees", () => {
    const tx = operation("decrease", 5);
    expect(() => parsePositionCashflowEvents(tx.meta!.logMessages, tx, context)).toThrow(/principal.*fees.*unavailable/i);
  });

  it("reports a missing nested position event instead of silently omitting the operation", () => {
    const tx = operation("increase", 5);
    const nested = tx.transaction.message.instructions.pop()!;
    tx.meta!.innerInstructions = [{ index: 0, instructions: [nested] }];
    expect(() => parsePositionCashflowEvents(tx.meta!.logMessages, tx, context)).toThrow(/nested position operation/);
    tx.meta!.logMessages = [encodedEvent("increase"), "Log truncated"];
    expect(parsePositionCashflowEvents(tx.meta!.logMessages, tx, context)).toHaveLength(1);
  });

  it("rejects unsupported fee-bearing transfer receipts instead of treating them as zero", () => {
    const tx = operation("increase", 5);
    const transfer = tx.meta!.innerInstructions![1]!.instructions[0]!;
    if (!("parsed" in transfer)) throw new Error("Expected transfer");
    transfer.parsed.type = "transferCheckedWithFee";
    expect(() => parsePositionCashflowEvents(tx.meta!.logMessages, tx, context)).toThrow(/amounts are unavailable/);
  });
});

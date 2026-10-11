import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { CLMM_PROGRAM_ID } from "@raydium-io/raydium-sdk-v2";
import { describe, expect, it } from "vitest";
import { decodeRaydiumLiquidityEvent, parsePositionCashflowEvents, parseRaydiumEventsFromLogs } from "./position-performance-events";
import fixtures from "./fixtures/position-liquidity-history-replay.json";

const samples = fixtures.map((fixture, index) => {
  const tx = JSON.parse(JSON.stringify(fixture), (key, value) => {
    if (key === "programId") return new PublicKey(value);
    if (key === "accounts") return value.map((address: string) => new PublicKey(address));
    return value;
  }) as ParsedTransactionWithMeta;
  const expected = parseRaydiumEventsFromLogs(tx.meta?.logMessages);
  if (expected.length !== 1 || expected[0]!.kind === "open") throw new Error("Expected one liquidity event");
  return { name: `transaction ${index + 1}`, tx, event: expected[0]! };
});

describe("real position transaction replay with truncated final events", () => {
  it("covers both additions and withdrawals from the captured RPC history", () => {
    expect(samples.filter(sample => sample.event.kind === "increase").length).toBeGreaterThan(10);
    expect(samples.filter(sample => sample.event.kind === "decrease").length).toBeGreaterThan(10);
  });

  it.each(samples)("restores $name to its original cashflow amounts", ({ tx, event }) => {
    const ix = tx.transaction.message.instructions.find(instruction => instruction.programId.equals(CLMM_PROGRAM_ID));
    if (!ix || !("accounts" in ix)) throw new Error("Missing Raydium instruction");
    const account = (index: number) => ix.accounts[index]!.toBase58();
    const increase = event.kind === "increase";
    const context = {
      positionMint: event.positionNftMint,
      positionAccount: account(increase ? 4 : 2), poolId: account(increase ? 2 : 3),
      vaultA: account(increase ? 9 : 5), vaultB: account(increase ? 10 : 6),
      mintA: account(increase ? 13 : 14), mintB: account(increase ? 14 : 15),
    };
    const logs = tx.meta!.logMessages!;
    const finalEvent = logs.findIndex(line => line.startsWith("Program data: ") &&
      decodeRaydiumLiquidityEvent(Buffer.from(line.slice(14), "base64"))?.kind === event.kind);
    const truncated = [...logs.slice(0, finalEvent), "Log truncated"];
    expect(parsePositionCashflowEvents(truncated, tx, context)).toEqual([event]);
  });
});

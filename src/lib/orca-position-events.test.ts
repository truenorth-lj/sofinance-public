import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { decodeOrcaPosition } from "@sofinance/engine/protocols/orca/position";
import { ORCA_WHIRLPOOL_PROGRAM_ID } from "@sofinance/engine/protocols/orca/constants";
import accounts from "../../packages/engine/src/fixtures/orca-positions-cbbtc-wbtc.json";
import fixtures from "./fixtures/orca-position-history-cbbtc-wbtc.json";
import { parseOrcaPositionCashflowEvents } from "./orca-position-events";
import { aggregateCashflowsForPosition, type PositionCashflowEvent } from "./position-performance-events";

const POOL = accounts.pool;
const VAULT_A = "Br2L7L6Vfro799PuNH7xdQPs6bZ4DGi2DMFsUX3DdUPW";
const VAULT_B = "4WBthDFFdS8mqJ3o9hoxtaEewcn7nuXpqUnQiHhJfHVQ";
const hydrate = (value: unknown) => JSON.parse(JSON.stringify(value), (key, v) => {
  if (key === "programId") return new PublicKey(v);
  if (key === "accounts" && Array.isArray(v)) return v.map((address: string) => new PublicKey(address));
  return v;
}) as ParsedTransactionWithMeta & { label: string; position: string };
const txs = fixtures.map(hydrate);
const contextFor = (position: string) => {
  const index = accounts.positions.indexOf(position);
  return { positionMint: accounts.positionMints[index]!, positionAccount: position, poolId: POOL,
    mintA: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij", mintB: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", vaultA: VAULT_A, vaultB: VAULT_B };
};
const parse = (tx: ParsedTransactionWithMeta, position: string, logs = tx.meta?.logMessages) => parseOrcaPositionCashflowEvents(logs, tx, contextFor(position));
const historyOf = (position: string) => txs.filter((tx) => tx.position === position);
const liquidityDelta = (events: PositionCashflowEvent[]) => events.reduce((sum, event) => sum + BigInt(event.liquidity) * (event.kind === "decrease" ? -1n : 1n), 0n);
const onChain = (position: string) => decodeOrcaPosition(Buffer.from((accounts.accounts as Record<string, { data: string }>)[position]!.data, "base64"));
const [IN_RANGE, ABOVE, BELOW] = accounts.positions as [string, string, string];

describe("Orca position receipts (mainnet cbBTC/WBTC history)", () => {
  it.each(accounts.positions)("replays %s to its captured on-chain liquidity", (position) => {
    const events = historyOf(position).flatMap((tx) => parse(tx, position));
    expect(events[0]!.kind).toBe("open");
    expect(events.filter((event) => event.kind === "open")).toHaveLength(1);
    expect(liquidityDelta(events)).toBe(onChain(position).liquidity);
  });

  it("recovers exact deposits, principal withdrawals and collected fees", () => {
    const events = historyOf(BELOW).flatMap((tx) => parse(tx, BELOW));
    expect(aggregateCashflowsForPosition(events, contextFor(BELOW).positionMint, POOL)).toEqual({
      depositedA: 982386n, depositedB: 101184n, withdrawnPrincipalA: 508877n, withdrawnPrincipalB: 0n,
      feesCollectedA: 2192n, feesCollectedB: 2186n, openCount: 1, increaseCount: 20, decreaseCount: 13,
    });
    expect(aggregateCashflowsForPosition(historyOf(ABOVE).flatMap((tx) => parse(tx, ABOVE)), contextFor(ABOVE).positionMint, POOL))
      .toMatchObject({ depositedA: 11318n, depositedB: 13563n, openCount: 1, increaseCount: 3, decreaseCount: 0 });
  });

  it("folds the same-transaction first deposit into the open", () => {
    const [open] = historyOf(BELOW);
    expect(parse(open!, BELOW)).toEqual([{ kind: "open", poolState: POOL, nftOwner: expect.any(String), tickLower: 18, tickUpper: 38,
      liquidity: expect.stringMatching(/^[1-9]\d*$/), amountA: "35849", amountB: "39552" }]);
  });

  it("reads collect_fees as a fee-only zero-liquidity withdrawal and ignores other positions in the transaction", () => {
    const collect = historyOf(BELOW)[3]!; // update_fees + collect_fees_v2 (another position) + update_fees + collect_fees (this one)
    expect(parse(collect, BELOW)).toEqual([{ kind: "decrease", positionNftMint: contextFor(BELOW).positionMint, liquidity: "0",
      principalA: "0", principalB: "0", feeA: "34", feeB: "33" }]);
    expect(parse(collect, IN_RANGE)).toEqual([]);
  });

  it("reads decrease_liquidity as principal only", () => {
    const decrease = historyOf(BELOW).find((tx) => parse(tx, BELOW).some((event) => event.kind === "decrease" && event.liquidity !== "0"))!;
    expect(parse(decrease, BELOW)).toEqual([expect.objectContaining({ kind: "decrease", principalA: "508877", principalB: "0", feeA: "0", feeB: "0" })]);
  });

  it("takes by-token-amount liquidity from the LiquidityIncreased event and rejects it when logs are truncated", () => {
    const byAmounts = historyOf(IN_RANGE)[1]!;
    const [event] = parse(byAmounts, IN_RANGE);
    expect(event).toMatchObject({ kind: "increase" });
    const truncated = byAmounts.meta!.logMessages!.filter((line) => !line.startsWith("Program data: "));
    expect(() => parse(byAmounts, IN_RANGE, [...truncated, "Log truncated"])).toThrow("LiquidityIncreased event");
    // v1 increase carries liquidity in its data: logs are not needed.
    const v1 = historyOf(BELOW)[1]!;
    expect(parse(v1, BELOW, ["Log truncated"])).toEqual(parse(v1, BELOW));
  });

  it("returns nothing for failed transactions", () => {
    const failed = { ...historyOf(BELOW)[1]!, meta: { ...historyOf(BELOW)[1]!.meta!, err: { InstructionError: [3, "Custom"] } } };
    expect(parse(failed as ParsedTransactionWithMeta, BELOW)).toEqual([]);
  });

  it("rejects receipts it cannot represent exactly", () => {
    const tx = historyOf(BELOW)[1]!;
    const wrongVault = { ...contextFor(BELOW), vaultA: VAULT_B };
    expect(() => parseOrcaPositionCashflowEvents(tx.meta!.logMessages, tx, wrongVault)).toThrow("do not match");

    const mismatched = structuredClone(fixtures.find((item) => item.label === historyOf(BELOW)[1]!.label)!);
    const transfer = mismatched.meta.innerInstructions[0]!.instructions.find((ix) => "parsed" in ix) as { parsed: { info: { amount?: string; tokenAmount?: { amount: string } } } };
    if (transfer.parsed.info.tokenAmount) transfer.parsed.info.tokenAmount.amount = "1"; else transfer.parsed.info.amount = "1";
    expect(() => parse(hydrate(mismatched), BELOW)).toThrow("does not match its transfers");

    const noReceipts = { ...tx, meta: { ...tx.meta!, innerInstructions: null } };
    expect(() => parse(noReceipts as ParsedTransactionWithMeta, BELOW)).toThrow("receipts are unavailable");
  });

  it("rejects position operations invoked through another program", () => {
    const tx = historyOf(BELOW)[1]!;
    const outer = tx.transaction.message.instructions.findIndex((ix) => ix.programId.toBase58() === ORCA_WHIRLPOOL_PROGRAM_ID);
    const cpi = structuredClone(fixtures.find((item) => item.label === tx.label)!);
    const orca = cpi.transaction.message.instructions[outer]!;
    cpi.transaction.message.instructions[outer] = { programId: "11111111111111111111111111111111", accounts: [], data: "" };
    cpi.meta.innerInstructions[0]!.instructions.unshift({ ...orca, stackHeight: 2 } as never);
    expect(() => parse(hydrate(cpi), BELOW)).toThrow("invoked through another program");
  });
});

import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import bs58 from "bs58";
import { beforeEach, describe, expect, it, vi } from "vitest";
import accounts from "../../packages/engine/src/fixtures/meteora-positions-cbbtc-wbtc.json";
import fixtures from "./fixtures/meteora-position-history-cbbtc-wbtc.json";
import claimFee2Fixtures from "./fixtures/meteora-position-history-nvda-claimfee2.json";

vi.mock("server-only", () => ({}));
// `hideAllowlist`: read the pool as a feed-listed one (absent from the static allowlist).
const allowlistState = vi.hoisted(() => ({ hideAllowlist: false }));
vi.mock("@sofinance/engine/protocols/meteora/constants", async (importOriginal) => {
  const real = await importOriginal<typeof import("@sofinance/engine/protocols/meteora/constants")>();
  return { ...real, get METEORA_ALLOWLISTED_POOLS() { return allowlistState.hideAllowlist ? [] : real.METEORA_ALLOWLISTED_POOLS; } };
});
vi.mock("./position-performance-history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./position-performance-history")>()),
  fetchPositionHistoryTransactions: vi.fn(),
}));

const { fetchPositionHistoryTransactions } = await import("./position-performance-history");
const { METEORA_EVENT, METEORA_EVENT_AUTHORITY, METEORA_EVENT_IX_TAG, parseMeteoraPositionCashflowEvents } = await import("./meteora-position-events");
const { aggregateCashflowsForPosition } = await import("./position-performance-events");
const { getMeteoraPositionPerformance, METEORA_POOL_NOT_SUPPORTED } = await import("./meteora-positions");

const POOL = accounts.pool;
const CBBTC = "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij";
const WBTC = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh";
const RESERVE_X = "5LaTKNpjhHoxmWrCFPqhSkUHKdzpK3b95PdDwQecCxmH";
const RESERVE_Y = "Hrz5yLrAKJtC5FttkWEupPwsYSVteEJiKoNrwvjnvxRs";
const [IN_RANGE, , , , EMPTY] = accounts.positions as [string, string, string, string, string];
const expected = accounts.expected as Record<string, { owner: string; lowerBinId: number; upperBinId: number; totalClaimedFeeX: string; totalClaimedFeeY: string }>;

type Tx = ParsedTransactionWithMeta & { label: string; position: string };
const hydrate = (value: unknown) => JSON.parse(JSON.stringify(value), (key, v) => {
  if (key === "programId") return new PublicKey(v);
  if (key === "accounts" && Array.isArray(v)) return v.map((address: string) => new PublicKey(address));
  return v;
}) as Tx;
const history = (fixtures as unknown[]).map(hydrate);
const historyOf = (position: string) => history.filter((tx) => tx.position === position);
const contextFor = (position: string) => ({
  positionMint: position, positionAccount: position, poolId: POOL, mintA: CBBTC, mintB: WBTC, vaultA: RESERVE_X, vaultB: RESERVE_Y,
  lowerBinId: expected[position]!.lowerBinId, upperBinId: expected[position]!.upperBinId,
});
const parseAll = (position: string) => historyOf(position).flatMap((tx) => parseMeteoraPositionCashflowEvents(tx, contextFor(position)));
const clone = (tx: Tx) => hydrate(JSON.parse(JSON.stringify(tx, (_key, v) => (v instanceof PublicKey ? v.toBase58() : v))));
const eventData = (disc: string, fields: Buffer) => bs58.encode(Buffer.concat([Buffer.from(METEORA_EVENT_IX_TAG + disc, "hex"), fields]));

describe("parseMeteoraPositionCashflowEvents (mainnet receipts)", () => {
  it("rebuilds the empty position's ledger; claimed fees equal the on-chain totals", () => {
    const events = parseAll(EMPTY);
    const totals = aggregateCashflowsForPosition(events, EMPTY, POOL);
    expect(totals).toEqual({
      depositedA: 267983n, depositedB: 287259n, withdrawnPrincipalA: 0n, withdrawnPrincipalB: 555743n,
      feesCollectedA: BigInt(expected[EMPTY]!.totalClaimedFeeX), feesCollectedB: BigInt(expected[EMPTY]!.totalClaimedFeeY),
      openCount: 1, increaseCount: 1, decreaseCount: 25,
    });
    expect(events[0]).toEqual({ kind: "open", poolState: POOL, nftOwner: expected[EMPTY]!.owner, tickLower: -34, tickUpper: 35,
      liquidity: "0", amountA: "265331", amountB: "271355" });
  });

  it("folds the same-transaction first add into the open and ignores maintenance-only receipts", () => {
    const [open, maintenance] = historyOf(IN_RANGE);
    expect(parseMeteoraPositionCashflowEvents(open, contextFor(IN_RANGE))).toEqual([{ kind: "open", poolState: POOL,
      nftOwner: expected[IN_RANGE]!.owner, tickLower: -15, tickUpper: 54, liquidity: "0", amountA: "86276228", amountB: "85524348" }]);
    expect(parseMeteoraPositionCashflowEvents(maintenance, contextFor(IN_RANGE))).toEqual([]);
    // Another position's receipts never leak into this ledger.
    expect(historyOf(EMPTY).flatMap((tx) => parseMeteoraPositionCashflowEvents(tx, contextFor(IN_RANGE)))).toEqual([]);
  });

  it("rejects receipts whose reserve transfers do not match the event", () => {
    const claim = clone(historyOf(EMPTY)[1]!);
    const transfer = claim.meta!.innerInstructions![0]!.instructions[0] as { parsed: { info: { tokenAmount: { amount: string } } } };
    transfer.parsed.info.tokenAmount.amount = "761";
    expect(() => parseMeteoraPositionCashflowEvents(claim, contextFor(EMPTY))).toThrow(/do not match the reserve transfers/);
    const missing = clone(historyOf(EMPTY)[1]!);
    missing.meta!.innerInstructions![0]!.instructions.splice(0, 1);
    expect(() => parseMeteoraPositionCashflowEvents(missing, contextFor(EMPTY))).toThrow(/do not match/);
  });

  it("ignores forged events not signed by the event authority, and rejects rebalancing or ambiguous groups", () => {
    const claim = clone(historyOf(EMPTY)[1]!);
    const group = claim.meta!.innerInstructions![0]!.instructions;
    const event = group.at(-1) as { accounts: PublicKey[]; data: string };
    expect(event.accounts[0]!.toBase58()).toBe(METEORA_EVENT_AUTHORITY);
    const forged = clone(claim);
    (forged.meta!.innerInstructions![0]!.instructions.at(-1) as { accounts: PublicKey[] }).accounts = [new PublicKey(CBBTC)];
    expect(parseMeteoraPositionCashflowEvents(forged, contextFor(EMPTY))).toEqual([]);

    const rebalance = clone(claim);
    const fields = Buffer.alloc(64 + 4 + 8 * 6 + 16 + 16);
    new PublicKey(POOL).toBuffer().copy(fields, 0);
    new PublicKey(EMPTY).toBuffer().copy(fields, 32);
    (rebalance.meta!.innerInstructions![0]!.instructions.at(-1) as { data: string }).data = eventData(METEORA_EVENT.rebalancing, fields);
    expect(() => parseMeteoraPositionCashflowEvents(rebalance, contextFor(EMPTY))).toThrow(/rebalancing is not supported/);

    const doubled = clone(claim);
    doubled.meta!.innerInstructions![0]!.instructions.push(doubled.meta!.innerInstructions![0]!.instructions.at(-1)!);
    expect(() => parseMeteoraPositionCashflowEvents(doubled, contextFor(EMPTY))).toThrow(/several liquidity operations/);

    expect(() => parseMeteoraPositionCashflowEvents(claim, { ...contextFor(EMPTY), poolId: CBBTC })).toThrow(/another pool/);
    const failed = clone(claim);
    failed.meta!.err = { InstructionError: [1, "Custom"] } as never;
    expect(parseMeteoraPositionCashflowEvents(failed, contextFor(EMPTY))).toEqual([]);
  });
});

describe("parseMeteoraPositionCashflowEvents (claim_fee2 emits ClaimFee and ClaimFee2)", () => {
  // Compound receipt from 2026-11-23: claim_fee2 (group 1: two transfers + ClaimFee + ClaimFee2, same amounts),
  // then add_liquidity_by_strategy2 (group 2).
  const [compound] = (claimFee2Fixtures as unknown[]).map(hydrate) as [Tx];
  const context = {
    positionMint: compound.position, positionAccount: compound.position, poolId: "Aq7nhS8pDPRvPA2uWotwyk79aG8Hfegf5CdA3iXABxAR",
    mintA: "NVDAVuiB7hwd3m5Wa1JuHNovPaPG6BH1QNztbKFxNjv", mintB: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
    vaultA: "6iFRjSA6194oAEUfZzdEJFqBcDsGkAviNc1yLWngT8NV", vaultB: "3fcqcgxVwQddGoh2FX4d9Wn7bxfuwFUnUFh6MS7erZNw",
    lowerBinId: 46032, upperBinId: 46041,
  };
  const claim = { kind: "decrease", positionNftMint: compound.position, liquidity: "0", principalA: "0", principalB: "0", feeA: "10871", feeB: "1118162" };
  const add = { kind: "increase", positionNftMint: compound.position, liquidity: "0", amountA: "10867", amountB: "1113486" };
  const claimGroup = (tx: Tx) => tx.meta!.innerInstructions!.find((group) => group.index === 1)!;
  const discOf = (instruction: unknown) => {
    const data = (instruction as { data?: string }).data;
    return data ? Buffer.from(bs58.decode(data)).subarray(8, 16).toString("hex") : null;
  };

  it("the fixture carries both claim events with identical amounts", () => {
    const events = claimGroup(compound).instructions.map(discOf).filter((disc) => disc === METEORA_EVENT.claimFee || disc === METEORA_EVENT.claimFee2);
    expect(events).toEqual([METEORA_EVENT.claimFee, METEORA_EVENT.claimFee2]);
  });

  it("counts one claim_fee2 once, then the add", () => {
    expect(parseMeteoraPositionCashflowEvents(compound, context)).toEqual([claim, add]);
    expect(aggregateCashflowsForPosition(parseMeteoraPositionCashflowEvents(compound, context), compound.position, context.poolId))
      .toMatchObject({ feesCollectedA: 10871n, feesCollectedB: 1118162n, depositedA: 10867n, depositedB: 1113486n, decreaseCount: 1, increaseCount: 1 });
  });

  it("still parses a claim that emits only ClaimFee2", () => {
    const only = clone(compound);
    const group = claimGroup(only);
    group.instructions = group.instructions.filter((instruction) => discOf(instruction) !== METEORA_EVENT.claimFee);
    expect(parseMeteoraPositionCashflowEvents(only, context)).toEqual([claim, add]);
  });

  it("counts two separate claim_fee2 instructions twice", () => {
    const twice = clone(compound);
    twice.meta!.innerInstructions!.push({ ...clone(compound).meta!.innerInstructions!.find((group) => group.index === 1)!, index: 3 });
    expect(parseMeteoraPositionCashflowEvents(twice, context)).toEqual([claim, add, claim]);
  });

  it("rejects two claims inside one instruction group", () => {
    const doubled = clone(compound);
    const group = claimGroup(doubled);
    group.instructions = [...group.instructions, ...clone(compound).meta!.innerInstructions!.find((item) => item.index === 1)!.instructions];
    expect(() => parseMeteoraPositionCashflowEvents(doubled, context)).toThrow(/several liquidity operations/);
  });

  it("does not pair ClaimFee and ClaimFee2 whose amounts differ", () => {
    const differ = clone(compound);
    const event = claimGroup(differ).instructions.find((instruction) => discOf(instruction) === METEORA_EVENT.claimFee2) as { data: string };
    const data = Buffer.from(bs58.decode(event.data));
    data.writeBigUInt64LE(10870n, 16 + 96);
    event.data = bs58.encode(data);
    expect(() => parseMeteoraPositionCashflowEvents(differ, context)).toThrow(/several liquidity operations/);
  });
});

describe("getMeteoraPositionPerformance", () => {
  beforeEach(() => vi.clearAllMocks());
  const store = new Map(Object.entries(accounts.accounts).flatMap(([address, raw]) =>
    raw ? [[address, { owner: new PublicKey(raw.owner), data: Buffer.from(raw.data, "base64") }] as const] : []));
  const items = historyOf(EMPTY).map((tx) => ({ signature: tx.label, slot: tx.slot, blockTime: tx.blockTime ?? null, err: null, logMessages: null, parsedTransaction: tx }));
  const connection = {
    getAccountInfo: vi.fn(async (key: PublicKey) => store.get(key.toBase58()) ?? null),
    getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map((key) => store.get(key.toBase58()) ?? null)),
    getProgramAccounts: vi.fn(async () => []),
    getSignaturesForAddress: vi.fn(async () => []),
    getParsedTransaction: vi.fn(),
  } as unknown as NonNullable<Parameters<typeof getMeteoraPositionPerformance>[1]>["connection"];

  it("reports cashflows, live equity and holding period for a position opened anywhere", async () => {
    vi.mocked(fetchPositionHistoryTransactions).mockResolvedValue({ items, truncated: false, signatureCount: items.length, metric: { elapsedMs: 1 } as never });
    const result = (await getMeteoraPositionPerformance(EMPTY, { connection, skipPricing: true, nowSeconds: 1_800_000_000,
      wallet: expected[EMPTY]!.owner, fetcher: vi.fn(async () => { throw new Error("offline"); }) as never }))!;
    expect(result).toMatchObject({
      positionAccount: EMPTY, positionMint: EMPTY, poolId: POOL, mintA: CBBTC, mintB: WBTC, tickLower: -34, tickUpper: 35, ownsNft: true,
      cashflows: { depositedA: "267983", depositedB: "287259", withdrawnPrincipalA: "0", withdrawnPrincipalB: "555743",
        feesCollectedA: "2713", feesCollectedB: "2864", openCount: 1, increaseCount: 1, decreaseCount: 25 },
      pricing: { source: "none" }, openedAt: items[0]!.blockTime,
    });
    expect(result.assumptions).toMatch(/Meteora DLMM/);
    expect(result.assumptions).not.toMatch(/incomplete/);
    expect(result.metrics.holdingDays).toBeGreaterThan(0);

    vi.mocked(fetchPositionHistoryTransactions).mockResolvedValue({ items: items.slice(1), truncated: true, signatureCount: 500, metric: { elapsedMs: 1 } as never });
    const partial = (await getMeteoraPositionPerformance(EMPTY, { connection, skipPricing: true, nowSeconds: 1_800_000_000,
      fetcher: vi.fn(async () => { throw new Error("offline"); }) as never }))!;
    expect(partial.assumptions).toMatch(/incomplete/);
    expect(partial.metrics.feeOnlyAprPct).toBeNull();
  });

  it("reads a feed-listed pool missing from the static allowlist (symbols fall back to token metadata, then none)", async () => {
    allowlistState.hideAllowlist = true;
    try {
      vi.mocked(fetchPositionHistoryTransactions).mockResolvedValue({ items, truncated: false, signatureCount: items.length, metric: { elapsedMs: 1 } as never });
      const listedPool = vi.fn(async () => ({ mints: [CBBTC, WBTC] as const, binStep: null }));
      const result = (await getMeteoraPositionPerformance(EMPTY, { connection, listedPool, skipPricing: true, nowSeconds: 1_800_000_000,
        fetcher: vi.fn(async () => { throw new Error("offline"); }) as never }))!;
      expect(result).toMatchObject({ poolId: POOL, mintA: CBBTC, mintB: WBTC });
      expect(result.tokenNative).toMatchObject({ symbolA: null, symbolB: null });
    } finally {
      allowlistState.hideAllowlist = false;
    }
  });

  it("a position in a pool the listing lookup does not list is refused before any history is read", async () => {
    const listedPool = vi.fn(async () => null);
    await expect(getMeteoraPositionPerformance(EMPTY, { connection, listedPool, skipPricing: true })).rejects.toThrow(METEORA_POOL_NOT_SUPPORTED);
    expect(listedPool).toHaveBeenCalledWith(POOL);
    expect(fetchPositionHistoryTransactions).not.toHaveBeenCalled();
  });

  it("is null for non-Meteora addresses and never reads the open log or the signature history for provenance", async () => {
    expect(await getMeteoraPositionPerformance(POOL, { connection })).toBeNull();
    expect(fetchPositionHistoryTransactions).not.toHaveBeenCalled();
    expect(connection!.getSignaturesForAddress).not.toHaveBeenCalled();
  });
});

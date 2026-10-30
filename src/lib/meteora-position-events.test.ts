import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import bs58 from "bs58";
import { beforeEach, describe, expect, it, vi } from "vitest";
import accounts from "../../packages/engine/src/fixtures/meteora-positions-cbbtc-wbtc.json";
import fixtures from "./fixtures/meteora-position-history-cbbtc-wbtc.json";

vi.mock("server-only", () => ({}));
vi.mock("./position-performance-history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./position-performance-history")>()),
  fetchPositionHistoryTransactions: vi.fn(),
}));

const { fetchPositionHistoryTransactions } = await import("./position-performance-history");
const { METEORA_EVENT, METEORA_EVENT_AUTHORITY, METEORA_EVENT_IX_TAG, parseMeteoraPositionCashflowEvents } = await import("./meteora-position-events");
const { aggregateCashflowsForPosition } = await import("./position-performance-events");
const { getMeteoraPositionPerformance } = await import("./meteora-positions");

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

  it("is null for non-Meteora addresses and never reads the open log or the signature history for provenance", async () => {
    expect(await getMeteoraPositionPerformance(POOL, { connection })).toBeNull();
    expect(fetchPositionHistoryTransactions).not.toHaveBeenCalled();
    expect(connection!.getSignaturesForAddress).not.toHaveBeenCalled();
  });
});

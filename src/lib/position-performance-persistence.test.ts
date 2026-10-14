import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLMM_PROGRAM_ID, getPdaPersonalPositionAddress, PersonalPositionLayout,
  PoolInfoLayout, TickArrayLayout, TickArrayUtil, TickLayout, TickUtil } from "@raydium-io/raydium-sdk-v2";
import { Keypair, PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
vi.mock("server-only", () => ({}));
const ledger = vi.hoisted(() => vi.fn());
const transports = vi.hoisted(() => ({ valuation: vi.fn(), history: vi.fn() }));
vi.mock("./position-performance-history-load", () => ({ loadPerformanceHistory: ledger }));
vi.mock("./rpc", async original => ({ ...(await original<typeof import("./rpc")>()), rpcConnection: transports.valuation }));
vi.mock("./position-history-rpc", () => ({ createHistoryRpcConnections: transports.history }));
import { getPositionPerformance } from "./position-performance";
import type { PositionHistoryStore } from "./position-history-store-types";
const key = () => Keypair.generate().publicKey;
const nft = key(), pool = key(), mintA = key(), mintB = key(), vaultA = key(), vaultB = key();
const position = getPdaPersonalPositionAddress(CLMM_PROGRAM_ID, nft).publicKey;
const accounts = new Map<string, AccountInfo<Buffer>>();
const info = (data: Buffer) => ({ data, owner: CLMM_PROGRAM_ID, executable: false, lamports: 1, rentEpoch: 0 });
const accountRead = vi.fn(async (address: PublicKey) => accounts.get(address.toBase58()) ?? null);
const tickRead = vi.fn(async () => [-120, 60].map(start => {
  const data = Buffer.alloc(TickArrayLayout.span);
  pool.toBuffer().copy(data, TickArrayLayout.offsetOf("poolId"));
  data.writeInt32LE(start, TickArrayLayout.offsetOf("startTickIndex"));
  for (const tick of [-100, 100]) {
    if (TickArrayUtil.getTickArrayStartIndex(tick, 1) !== start) continue;
    data.writeInt32LE(tick, TickArrayLayout.offsetOf("ticks") + TickArrayUtil.getTickOffsetInArray(tick, 1) * TickLayout.span);
  }
  return info(data);
}));
const connection = { getAccountInfo: accountRead, getMultipleAccountsInfo: tickRead } as unknown as Connection;
const store: PositionHistoryStore = { request: vi.fn() };
const fetcher = vi.fn(async () => Response.json({ data: [{ mintA: { symbol: "HOODx" }, mintB: { symbol: "HOOD" } }] }));
beforeEach(() => {
  vi.clearAllMocks(); accounts.clear();
  const data = Buffer.alloc(PersonalPositionLayout.span);
  createHash("sha256").update("account:PersonalPositionState").digest().copy(data, 0, 0, 8);
  nft.toBuffer().copy(data, PersonalPositionLayout.offsetOf("nftMint"));
  pool.toBuffer().copy(data, PersonalPositionLayout.offsetOf("poolId"));
  data.writeInt32LE(-100, PersonalPositionLayout.offsetOf("tickLower"));
  data.writeInt32LE(100, PersonalPositionLayout.offsetOf("tickUpper"));
  data.writeBigUInt64LE(10000n, PersonalPositionLayout.offsetOf("liquidity"));
  data.writeBigUInt64LE(17n, PersonalPositionLayout.offsetOf("tokenFeesOwedA"));
  accounts.set(position.toBase58(), info(data));
  const poolData = Buffer.alloc(PoolInfoLayout.span);
  createHash("sha256").update("account:PoolState").digest().copy(poolData, 0, 0, 8);
  for (const [field, value] of [["mintA", mintA], ["mintB", mintB], ["vaultA", vaultA], ["vaultB", vaultB]] as const) {
    value.toBuffer().copy(poolData, PoolInfoLayout.offsetOf(field));
  }
  poolData[PoolInfoLayout.offsetOf("mintDecimalsA")] = 6;
  poolData[PoolInfoLayout.offsetOf("mintDecimalsB")] = 6;
  poolData.writeUInt16LE(1, PoolInfoLayout.offsetOf("tickSpacing"));
  TickUtil.getSqrtPriceAtTick(0).toArrayLike(Buffer, "le", 16).copy(poolData, PoolInfoLayout.offsetOf("sqrtPriceX64"));
  accounts.set(pool.toBase58(), info(poolData));
  ledger.mockResolvedValue({ history: [{ signature: "a".repeat(64), slot: 1, blockTime: 1700000000,
    events: [{ kind: "open", poolState: pool.toBase58(), nftOwner: key().toBase58(), tickLower: -100,
      tickUpper: 100, liquidity: "10000", amountA: "100000000", amountB: "100000000" }] }],
    signatureCount: 1, truncated: false,
    metric: { txCount: 1, elapsedMs: 1, provider: "default", source: "databaseIncremental",
      solamiTxCount: 0, defaultTxCount: 0, fallbackReasons: [], fetchedTxCount: 0, cachedTxCount: 1 } });
});
const lookup = (historyStore: PositionHistoryStore | null = store) => getPositionPerformance(nft.toBase58(), {
  connection, historyStore, skipPricing: true, fetcher, nowSeconds: 1700000000 + 3 * 86400,
});
describe("performance with persisted history", () => {
  it("uses the shared paced history transport without changing current valuation reads", async () => {
    const historyConnection = { getParsedTransaction: vi.fn(), getSignaturesForAddress: vi.fn() };
    const metric = { attemptCount: 2, rateLimitCount: 0, queuedMs: 1, requestMs: 2,
      maxActive: 1, primaryAttempts: 0, defaultAttempts: 2, responseBytes: 100 };
    const observer = { snapshot: vi.fn(() => metric), receiptProvider: vi.fn(() => "default" as const) };
    transports.valuation.mockReturnValue(connection);
    transports.history.mockReturnValue({ connection: historyConnection, observer });
    await getPositionPerformance(nft.toBase58(), { historyStore: store, skipPricing: true, fetcher });
    expect(transports.valuation).toHaveBeenCalledTimes(1);
    expect(accountRead).toHaveBeenCalledTimes(2);
    expect(tickRead).toHaveBeenCalledTimes(1);
    expect(transports.history).not.toHaveBeenCalled();
    expect(ledger.mock.calls[0]![0].maxDetailRequests).toBe(100);
    const sharedSignal = new AbortController().signal;
    const paced = ledger.mock.calls[0]![0].connectionsForSignal(sharedSignal);
    expect(transports.history).toHaveBeenCalledWith(sharedSignal);
    expect(paced.connection).toBe(historyConnection);
    expect(paced.rpcMetrics()).toEqual(metric);
    expect(paced.receiptProvider("receipt")).toBe("default");
  });
  it("reuses historical cashflows while reading changing current fees on every lookup", async () => {
    const first = await lookup();
    accounts.get(position.toBase58())!.data.writeBigUInt64LE(31n, PersonalPositionLayout.offsetOf("tokenFeesOwedA"));
    const second = await lookup();
    expect(first.cashflows).toEqual(second.cashflows);
    expect(first.metrics.uncollectedFeesRaw.a).toBe("17");
    expect(second.metrics.uncollectedFeesRaw.a).toBe("31");
    expect(accountRead).toHaveBeenCalledTimes(4);
    expect(tickRead).toHaveBeenCalledTimes(2);
    expect(ledger.mock.calls[0]?.[0].store).toBe(store);
    expect(ledger.mock.calls[0]?.[0].maxDetailRequests).toBeUndefined();
    expect(second.timings?.totalMs).toBeGreaterThanOrEqual(0);
  });
  it("hides estimated returns and the personal APR curve while history is incomplete", async () => {
    ledger.mockResolvedValueOnce({ ...(await ledger()), truncated: true });
    const result = await lookup();
    expect(result.metrics.holdingPeriodReturnPct).toBeNull();
    expect(result.metrics.pnlUsd).toBeNull();
    expect(result.tokenNative.tokenEquivalent?.metrics.feeOnlyAprPct).toBeNull();
    expect(result.tokenNative.perSideFeeAprPct).toEqual({ a: null, b: null });
    expect(result.realizedFeeAprSeries.points).toEqual([]);
    expect(result.assumptions).toContain("history is incomplete");
  });
  it("allows an explicit legacy reader for a controlled comparison", async () => {
    await lookup(null);
    expect(ledger.mock.calls[0]?.[0].store).toBeNull();
  });
  it("suppresses legacy returns too while a successful transaction is not in finalized history", async () => {
    const baseline = await ledger();
    ledger.mockResolvedValue({ ...baseline, truncated: true,
      metric: { ...baseline.metric, refreshSignaturesResolved: false, historyComplete: false } });
    const result = await lookup(null);
    expect(result.metrics.pnlUsd).toBeNull();
    expect(result.metrics.holdingPeriodReturnPct).toBeNull();
    expect(result.tokenNative.perSideFeeAprPct).toEqual({ a: null, b: null });
    expect(result.realizedFeeAprSeries.points).toEqual([]);
  });
});

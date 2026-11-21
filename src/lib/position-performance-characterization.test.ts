import { createHash } from "node:crypto";
import { PublicKey, Keypair, type AccountInfo, type Connection, type ParsedTransactionWithMeta } from "@solana/web3.js";
import {
  CLMM_PROGRAM_ID, getPdaPersonalPositionAddress, PersonalPositionLayout,
  PoolInfoLayout, TickArrayLayout, TickArrayUtil, TickLayout, TickUtil,
} from "@raydium-io/raydium-sdk-v2";
import { beforeEach, describe, expect, it, vi } from "vitest";
import orcaAccounts from "../../packages/engine/src/fixtures/orca-positions-cbbtc-wbtc.json";
import orcaHistoryFixture from "./fixtures/orca-position-history-cbbtc-wbtc.json";
import meteoraAccounts from "../../packages/engine/src/fixtures/meteora-positions-cbbtc-wbtc.json";
import meteoraHistoryFixture from "./fixtures/meteora-position-history-cbbtc-wbtc.json";
import type { PositionPerformanceResult } from "./position-performance";
import type { TokenPriceQuote } from "@sofinance/engine/token-prices";

vi.mock("server-only", () => ({}));
vi.mock("./position-performance-history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./position-performance-history")>()),
  fetchPositionHistoryTransactions: vi.fn(),
}));
vi.mock("./position-performance-history-load", () => ({ loadPerformanceHistory: vi.fn() }));
vi.mock("@sofinance/engine/token-prices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sofinance/engine/token-prices")>()),
  fetchTokenPricesUsd: vi.fn(),
}));
vi.mock("@sofinance/engine/token-metadata", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sofinance/engine/token-metadata")>()),
  getTokenMetadata: vi.fn(async () => ({})),
}));

const { fetchPositionHistoryTransactions } = await import("./position-performance-history");
const { loadPerformanceHistory } = await import("./position-performance-history-load");
const { fetchTokenPricesUsd } = await import("@sofinance/engine/token-prices");
const { getOrcaPositionPerformance } = await import("./orca-positions");
const { getMeteoraPositionPerformance } = await import("./meteora-positions");
const { getPositionPerformance, getPositionFigures } = await import("./position-performance");
const { positionFigures } = await import("./portfolio/figures");
const { readPortfolioHistory } = await import("./portfolio/history-snapshot");

const NOW = 1_800_000_000;
const PRICE = 100_000;

function stable(result: PositionPerformanceResult) {
  const { history, timings, historyFetch, ...rest } = result;
  return JSON.parse(JSON.stringify({
    ...rest,
    historyLength: history.length,
    historySignatures: history.map((item) => item.signature),
    timings: timings
      ? { totalMs: 0, accountsMs: 0, historyMs: 0, pricingMs: 0, metadataMs: 0 }
      : timings,
    historyFetch: historyFetch
      ? { ...historyFetch, elapsedMs: 0, memoryCacheAgeMs: undefined, stages: undefined, rpc: undefined }
      : historyFetch,
  }));
}

function quotes(mintA: string, mintB: string): Map<string, TokenPriceQuote> {
  return new Map([
    [mintA, { price: PRICE, source: "jupiter", basis: "per-share" }],
    [mintB, { price: PRICE, source: "jupiter", basis: "per-share" }],
  ]);
}

function hydrate(value: unknown) {
  return JSON.parse(JSON.stringify(value), (key, v) => {
    if (key === "programId") return new PublicKey(v);
    if (key === "accounts" && Array.isArray(v)) return v.map((address: string) => new PublicKey(address));
    return v;
  }) as ParsedTransactionWithMeta & { label: string; position: string };
}

function historyItems(rows: Array<ParsedTransactionWithMeta & { label: string }>, truncated = false) {
  const items = rows.map((tx) => ({
    signature: tx.label, slot: tx.slot as unknown as number, blockTime: tx.blockTime as unknown as number,
    err: null, logMessages: tx.meta?.logMessages ?? null, parsedTransaction: tx,
  }));
  return {
    items,
    truncated,
    signatureCount: truncated ? 500 : items.length,
    metric: {
      txCount: items.length, elapsedMs: 0, provider: "default" as const,
      source: "getParsedTransactionBatch" as const, defaultTxCount: items.length, fallbackReasons: [],
    },
  };
}

type AccountStore = Map<string, { owner: PublicKey; data: Buffer }>;
function accountConnection(store: AccountStore) {
  return {
    getAccountInfo: vi.fn(async (key: PublicKey) => store.get(key.toBase58()) ?? null),
    getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map((key) => store.get(key.toBase58()) ?? null)),
    getProgramAccounts: vi.fn(async () => []),
    getTokenAccountsByOwner: vi.fn(async () => ({ context: { slot: 1 }, value: [] })),
    getSignaturesForAddress: vi.fn(async () => []),
    getParsedTransaction: vi.fn(async () => null),
  } as unknown as Connection;
}

function encodedStore(accounts: Record<string, { owner: string; data: string } | null | undefined>): AccountStore {
  const store: AccountStore = new Map();
  for (const [address, account] of Object.entries(accounts)) {
    if (!account) continue;
    store.set(address, { owner: new PublicKey(account.owner), data: Buffer.from(account.data, "base64") });
  }
  return store;
}

beforeEach(() => {
  vi.mocked(fetchPositionHistoryTransactions).mockReset();
  vi.mocked(loadPerformanceHistory).mockReset();
  vi.mocked(fetchTokenPricesUsd).mockReset();
});

describe("Orca position performance characterization", () => {
  const CBBTC = "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij";
  const WBTC = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh";
  const position = (orcaAccounts.positions as string[])[2]!;
  const mint = orcaAccounts.positionMints[orcaAccounts.positions.indexOf(position)]!;
  const history = (orcaHistoryFixture as unknown[]).map(hydrate).filter((tx) => tx.position === position);
  let connection: Connection;

  beforeEach(() => {
    const store = encodedStore(orcaAccounts.accounts as Record<string, { owner: string; data: string }>);
    const mintData = Buffer.alloc(82);
    mintData[44] = 8; mintData[45] = 1;
    const tokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    store.set(CBBTC, { owner: tokenProgram, data: Buffer.from(mintData) });
    store.set(WBTC, { owner: tokenProgram, data: Buffer.from(mintData) });
    connection = accountConnection(store);
  });

  async function run(kind: "full" | "truncated" | "pricing-failure" | "skip-pricing") {
    vi.mocked(fetchPositionHistoryTransactions).mockResolvedValue(
      kind === "truncated" ? historyItems(history.slice(1), true) : historyItems(history),
    );
    if (kind === "pricing-failure") vi.mocked(fetchTokenPricesUsd).mockRejectedValue(new Error("pricing failed"));
    else if (kind !== "skip-pricing") vi.mocked(fetchTokenPricesUsd).mockResolvedValue(quotes(CBBTC, WBTC));
    return getOrcaPositionPerformance(mint, {
      connection, nowSeconds: NOW, skipPricing: kind === "skip-pricing",
      fetcher: vi.fn(async () => { throw new Error("offline"); }) as never,
    });
  }

  it("records full history", async () => {
    expect(stable((await run("full"))!)).toMatchSnapshot();
  });
  it("records truncated history", async () => {
    expect(stable((await run("truncated"))!)).toMatchSnapshot();
  });
  it("records a pricing failure", async () => {
    expect(stable((await run("pricing-failure"))!)).toMatchSnapshot();
  });
  it("records skipPricing", async () => {
    expect(stable((await run("skip-pricing"))!)).toMatchSnapshot();
  });
});

describe("Meteora position performance characterization", () => {
  const CBBTC = "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij";
  const WBTC = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh";
  const position = (meteoraAccounts.positions as string[])[4]!;
  const history = (meteoraHistoryFixture as unknown[]).map(hydrate).filter((tx) => tx.position === position);
  const connection = accountConnection(encodedStore(meteoraAccounts.accounts as Record<string, { owner: string; data: string }>));

  async function run(kind: "full" | "truncated" | "pricing-failure" | "skip-pricing") {
    vi.mocked(fetchPositionHistoryTransactions).mockResolvedValue(
      kind === "truncated" ? historyItems(history.slice(1), true) : historyItems(history),
    );
    if (kind === "pricing-failure") vi.mocked(fetchTokenPricesUsd).mockRejectedValue(new Error("pricing failed"));
    else if (kind !== "skip-pricing") vi.mocked(fetchTokenPricesUsd).mockResolvedValue(quotes(CBBTC, WBTC));
    return getMeteoraPositionPerformance(position, {
      connection, nowSeconds: NOW, skipPricing: kind === "skip-pricing",
      fetcher: vi.fn(async () => { throw new Error("offline"); }) as never,
    });
  }

  it("records full history", async () => {
    expect(stable((await run("full"))!)).toMatchSnapshot();
  });
  it("records truncated history", async () => {
    expect(stable((await run("truncated"))!)).toMatchSnapshot();
  });
  it("records a pricing failure", async () => {
    expect(stable((await run("pricing-failure"))!)).toMatchSnapshot();
  });
  it("records skipPricing", async () => {
    expect(stable((await run("skip-pricing"))!)).toMatchSnapshot();
  });
});

describe("Raydium position performance characterization", () => {
  const key = (byte: number) => Keypair.fromSeed(Buffer.alloc(32, byte)).publicKey;
  const nft = key(1), pool = key(2), mintA = key(3), mintB = key(4), vaultA = key(5), vaultB = key(6), owner = key(7);
  const position = getPdaPersonalPositionAddress(CLMM_PROGRAM_ID, nft).publicKey;
  const accounts = new Map<string, AccountInfo<Buffer>>();
  const info = (data: Buffer): AccountInfo<Buffer> => ({ data, owner: CLMM_PROGRAM_ID, executable: false, lamports: 1, rentEpoch: 0 });

  const connection = {
    getAccountInfo: vi.fn(async (address: PublicKey) => accounts.get(address.toBase58()) ?? null),
    getMultipleAccountsInfo: vi.fn(async () => [-120, 60].map((start) => {
      const data = Buffer.alloc(TickArrayLayout.span);
      pool.toBuffer().copy(data, TickArrayLayout.offsetOf("poolId"));
      data.writeInt32LE(start, TickArrayLayout.offsetOf("startTickIndex"));
      for (const tick of [-100, 100]) {
        if (TickArrayUtil.getTickArrayStartIndex(tick, 1) !== start) continue;
        data.writeInt32LE(tick, TickArrayLayout.offsetOf("ticks") + TickArrayUtil.getTickOffsetInArray(tick, 1) * TickLayout.span);
      }
      return info(data);
    })),
  } as unknown as Connection;

  const openEvent = {
    signature: "a".repeat(64), slot: 1, blockTime: 1_700_000_000,
    events: [{ kind: "open" as const, poolState: pool.toBase58(), nftOwner: owner.toBase58(), tickLower: -100,
      tickUpper: 100, liquidity: "10000", amountA: "100000000", amountB: "100000000" }],
  };
  const metric = {
    txCount: 1, elapsedMs: 0, provider: "default" as const, source: "databaseIncremental" as const,
    defaultTxCount: 0, fallbackReasons: [], fetchedTxCount: 0, cachedTxCount: 1,
  };

  beforeEach(() => {
    accounts.clear();
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
  });

  async function run(kind: "full" | "truncated" | "pricing-failure" | "skip-pricing") {
    vi.mocked(loadPerformanceHistory).mockResolvedValue({
      history: kind === "truncated" ? [] : [openEvent],
      signatureCount: kind === "truncated" ? 500 : 1,
      truncated: kind === "truncated",
      metric,
    });
    if (kind === "pricing-failure") vi.mocked(fetchTokenPricesUsd).mockRejectedValue(new Error("pricing failed"));
    else if (kind !== "skip-pricing") vi.mocked(fetchTokenPricesUsd).mockResolvedValue(quotes(mintA.toBase58(), mintB.toBase58()));
    return getPositionPerformance(nft.toBase58(), {
      connection, nowSeconds: NOW, skipPricing: kind === "skip-pricing", historyStore: { request: vi.fn() },
      fetcher: vi.fn(async () => { throw new Error("offline"); }) as never,
    });
  }

  it("records full history", async () => {
    expect(stable(await run("full"))).toMatchSnapshot();
  });
  it("compact Portfolio figures match the full report without entry-price or curve assembly", async () => {
    await run("full");
    const options = { connection, nowSeconds: NOW, historyStore: { request: vi.fn() },
      prices: quotes(mintA.toBase58(), mintB.toBase58()), symbols: { symbolA: "HOODx", symbolB: "HOOD" },
      fetcher: vi.fn(async () => { throw new Error("Unexpected entry-price I/O"); }) as never };
    const compact = await getPositionFigures(nft.toBase58(), options);
    // Supply the same labels to the full reader's existing Raydium metadata path.
    const full = await getPositionPerformance(nft.toBase58(), { ...options,
      fetcher: vi.fn(async () => Response.json({ data: [{ mintA: { symbol: "HOODx" }, mintB: { symbol: "HOOD" } }] })) });
    expect(compact.figures).toEqual(positionFigures(full));
    expect(compact.historyComplete).toBe(true);
    const compactRead = vi.mocked(loadPerformanceHistory).mock.calls.at(-2)![0];
    expect(compactRead.maxDetailRequests).toBe(8);
    expect(compact).not.toHaveProperty("history"); expect(compact).not.toHaveProperty("realizedFeeAprSeries");
    expect(options.fetcher).not.toHaveBeenCalled();
  });
  it("keeps current value/shares but withholds cumulative fees for missing opening or truncated history", async () => {
    await run("truncated");
    const compact = await getPositionFigures(nft.toBase58(), { connection, nowSeconds: NOW,
      prices: quotes(mintA.toBase58(), mintB.toBase58()), symbols: { symbolA: "HOODx", symbolB: "HOOD" } });
    expect(compact.historyComplete).toBe(false);
    expect(compact.figures.valueUsd).toBeTypeOf("number"); expect(compact.figures.shares).toBeTypeOf("number");
    expect(compact.figures.cumulativeFeesUsd).toBeNull();
  });

  it("values a supplied durable snapshot without entering the history synchronization path", async () => {
    await run("full");
    const options = { connection, nowSeconds: NOW, prices: quotes(mintA.toBase58(), mintB.toBase58()),
      symbols: { symbolA: "HOODx", symbolB: "HOOD" } };
    const expected = await getPositionFigures(nft.toBase58(), options);
    const saved: Awaited<ReturnType<typeof loadPerformanceHistory>> = await vi.mocked(loadPerformanceHistory).mock.results.at(-1)!.value;
    vi.mocked(loadPerformanceHistory).mockClear().mockImplementation(async () => { throw new Error("Foreground history RPC must not run"); });
    const actual = await getPositionFigures(nft.toBase58(), { ...options, historyResult: saved });
    expect(actual.figures).toEqual(expected.figures);
    expect(actual.historyComplete).toBe(true);
    const snapshot = { lease: null, state: { headSignature: saved.history.at(-1)?.signature ?? null,
      backfillBefore: null, complete: true, revision: 1, parserVersion: 1 }, syncing: false,
      readAt: "2026-11-15T00:02:00Z", updatedAt: "2026-11-15T00:00:00Z",
      transactions: saved.history.map((item) => ({ ...item, status: "parsed", receipt: null, parserVersion: 1 })) };
    // Use the production snapshot adapter: stale/forced does not mean an
    // incomplete ledger, and must keep the stored cumulative fees visible.
    for (const fresh of [false, true]) {
      const stale = await readPortfolioHistory({ context: { positionMint: nft.toBase58(), positionAccount: nft.toBase58(),
        poolId: nft.toBase58(), mintA: mintA.toBase58(), mintB: mintB.toBase58(), vaultA: nft.toBase58(), vaultB: nft.toBase58() },
        store: { request: vi.fn().mockResolvedValue({ readAt: snapshot.readAt, snapshot }) }, fresh });
      expect(stale.historyStatus).toBe("updating"); expect(stale.historyRefreshResolved).toBe(false);
      const stored = await getPositionFigures(nft.toBase58(), { ...options, historyResult: stale.history });
      expect(stored.figures).toEqual(expected.figures);
      expect(stored.historyComplete).toBe(true);
    }
    const cold = await getPositionFigures(nft.toBase58(), { ...options, historyResult: { ...saved, history: [], truncated: true } });
    expect(cold.figures.valueUsd).toBeTypeOf("number");
    expect(cold.figures.unclaimedFeesUsd).toBeTypeOf("number");
    expect(cold.figures.cumulativeFeesUsd).toBeNull();
    expect(vi.mocked(loadPerformanceHistory)).not.toHaveBeenCalled();
  });

  it("records truncated history", async () => {
    expect(stable(await run("truncated"))).toMatchSnapshot();
  });
  it("records a pricing failure", async () => {
    expect(stable(await run("pricing-failure"))).toMatchSnapshot();
  });
  it("records skipPricing", async () => {
    expect(stable(await run("skip-pricing"))).toMatchSnapshot();
  });
});

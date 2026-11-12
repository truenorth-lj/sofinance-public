import "@/lib/engine-host";
import "server-only";

import {
  CLMM_PROGRAM_ID,
  getPdaPersonalPositionAddress,
  getPdaTickArrayAddress,
  LiquidityMathUtil,
  PersonalPositionLayout,
  PoolInfoLayout,
  TickArrayLayout,
  TickArrayUtil,
  TickUtil,
} from "@raydium-io/raydium-sdk-v2";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { accruedFee } from "@sofinance/engine/compound-math";
import { positionSide } from "@sofinance/engine/quote-math";
import { rpcConnection, rpcProvider, type RpcProvider } from "@sofinance/engine/rpc";
import {
  type HistoryConnection,
  type HistoryFetchMetric,
} from "./position-performance-history";
import {
  aggregateCashflowsForPosition,
  type PositionCashflowEvent,
} from "./position-performance-events";
import {
  computePositionPerformance,
  computeTokenNativeMetrics,
  type PositionPerformanceMetrics,
  type TokenNativeMetrics,
} from "@sofinance/engine/position-performance-math";
import { matchWrapPairShape } from "./rwa-pairing";
import { JUPITER_PRICE_V3 } from "@sofinance/engine/jupiter/urls";
import type { StockPerformance } from "./position-performance-report";
import { type RealizedFeeAprSeries } from "./realized-fee-apr-series";
import { getRwaConfig } from "./config/rwa-env";
import { getPositionHistoryStore } from "./position-history-store";
import type { PositionHistoryStore } from "./position-history-store-types";
import { loadPerformanceHistory } from "./position-performance-history-load";
import {
  assemblePerformanceResult,
  capMaxSignatures,
  PERFORMANCE_READ_TIMEOUT_MS,
  priceAndLabel,
  resolveSymbols,
} from "./position-performance-assemble";
import { resetRpcCache } from "@sofinance/engine/rpc/cache";
import { createHistoryRpcConnections } from "./position-history-rpc";

const POSITION_DISCRIMINATOR = createHash("sha256").update("account:PersonalPositionState").digest().subarray(0, 8);
const POOL_DISCRIMINATOR = createHash("sha256").update("account:PoolState").digest().subarray(0, 8);

// At four public-RPC starts/second, 500 details cannot finish within the shared
// fifty-second deadline. Durable reads checkpoint in bounded chunks instead.
const MAX_PACED_HISTORY_DETAILS = 100;
export { DEFAULT_MAX_SIGNATURES, MAX_PERFORMANCE_SIGNATURES, PERFORMANCE_READ_TIMEOUT_MS, describePositionPricing } from "./position-performance-assemble";
export { JUPITER_PRICE_V3 };
export const RAYDIUM_POOL_IDS = "https://api-v3.raydium.io/pools/info/ids";


export type PositionHistoryEvent = {
  signature: string;
  blockTime: number | null;
  slot: number;
  events: PositionCashflowEvent[];
};

export type PositionPerformanceResult = {
  wallet: string | null;
  ownsNft: boolean | null;
  positionMint: string;
  positionAccount: string;
  poolId: string;
  mintA: string;
  mintB: string;
  decimalsA: number;
  decimalsB: number;
  tickLower: number;
  tickUpper: number;
  tickCurrent: number;
  rangeSide: "below" | "inside" | "above";
  liquidity: string;
  openedAt: number | null;
  openedAtIso: string | null;
  evaluatedAt: number;
  evaluatedAtIso: string;
  signatureCount: number;
  truncated: boolean;
  maxSignatures: number;
  history: PositionHistoryEvent[];
  cashflows: {
    depositedA: string;
    depositedB: string;
    withdrawnPrincipalA: string;
    withdrawnPrincipalB: string;
    feesCollectedA: string;
    feesCollectedB: string;
    openCount: number;
    increaseCount: number;
    decreaseCount: number;
  };
  metrics: PositionPerformanceMetrics;
  /** Token-native inventory + preferred TE for same-asset RWA wrap pairs. USD stays secondary. */
  tokenNative: TokenNativeMetrics;
  /** Same-stock pools: the stock view (share price, 24h, entry price, fees in shares); null otherwise or when pricing is skipped. */
  stock: StockPerformance | null;
  pricing: {
    source: PositionPricingSource;
    label: string;
    priceUsdA: number | null;
    priceUsdB: number | null;
  };
  method: string;
  assumptions: string;
  /** Sparse cumulative realized fee APR from already-parsed events. Not a daily fill. */
  realizedFeeAprSeries: RealizedFeeAprSeries;
  /** How position history was loaded (getSignaturesForAddress + batched getParsedTransaction). */
  historyFetch: HistoryFetchMetric;
  timings?: { totalMs: number; accountsMs: number; historyMs: number; pricingMs: number; metadataMs: number };
};

export type PositionPricingSource =
  | "jupiter-price-v3"
  | "dexscreener"
  | "raydium-pool-stable"
  | "dexscreener+jupiter"
  | "dexscreener+raydium"
  | "jupiter+raydium"
  | "dexscreener+jupiter+raydium"
  | "none";

export type GetPositionPerformanceOptions = {
  wallet?: string;
  maxSignatures?: number;
  /** Skip Jupiter USD pricing (tests / offline). */
  skipPricing?: boolean;
  connection?: Connection;
  fetcher?: typeof fetch;
  jupiterApiKey?: string;
  /** Injected now (unix seconds) for tests. */
  nowSeconds?: number;
  /** Override RPC provider label (tests). Defaults to `rpcProvider()`. */
  provider?: RpcProvider;
  /** Extra RPC for history detail fallback (tests). */
  fallbackConnection?: HistoryConnection;
  /** Explicit null selects the legacy reader for controlled comparisons. */
  historyStore?: PositionHistoryStore | null;
  refreshHistory?: boolean;
  historyAfterSignatures?: string[];
  /** Disable only the short history cache for controlled same-provider measurements. */
  historyMemoryCache?: boolean;
  signal?: AbortSignal;
};

async function fetchRaydiumPoolSymbols(
  poolId: string,
  fetcher: typeof fetch,
): Promise<{ symbolA: string | null; symbolB: string | null }> {
  const url = `${RAYDIUM_POOL_IDS}?ids=${encodeURIComponent(poolId)}`;
  try {
    const response = await fetcher(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { symbolA: null, symbolB: null };
    const body = (await response.json()) as {
      data?: Array<{ mintA?: { symbol?: string }; mintB?: { symbol?: string } } | null>;
    };
    const pool = body.data?.[0];
    const symbolA = typeof pool?.mintA?.symbol === "string" ? pool.mintA.symbol.trim() : null;
    const symbolB = typeof pool?.mintB?.symbol === "string" ? pool.mintB.symbol.trim() : null;
    return { symbolA: symbolA || null, symbolB: symbolB || null };
  } catch {
    return { symbolA: null, symbolB: null };
  }
}

async function readUncollectedFees(connection: Connection, programId: PublicKey, poolId: PublicKey, position: ReturnType<typeof PersonalPositionLayout.decode>, pool: ReturnType<typeof PoolInfoLayout.decode>) {
  const ticks = [position.tickLower, position.tickUpper];
  const starts = ticks.map((tick) => TickArrayUtil.getTickArrayStartIndex(tick, pool.tickSpacing));
  const keys = starts.map((start) => getPdaTickArrayAddress(programId, poolId, start).publicKey);
  const infos = await connection.getMultipleAccountsInfo(keys, "confirmed");
  const boundaries = infos.map((info, index) => {
    if (!info || !info.owner.equals(programId)) throw new Error("Boundary tick array missing for fee accrual");
    const array = TickArrayLayout.decode(info.data);
    if (array.poolId.toBase58() !== poolId.toBase58() || array.startTickIndex !== starts[index]) {
      throw new Error("Tick array does not match pool or start index");
    }
    const tick = array.ticks[TickArrayUtil.getTickOffsetInArray(ticks[index]!, pool.tickSpacing)];
    if (!tick || tick.tick !== ticks[index]) throw new Error("Boundary tick not initialized");
    return tick;
  });
  const lower = boundaries[0]!;
  const upper = boundaries[1]!;
  const fee = (side: "A" | "B") =>
    accruedFee({
      tickCurrent: pool.tickCurrent,
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      global: BigInt(pool[`feeGrowthGlobalX64${side}`].toString()),
      lowerOutside: BigInt(lower[`feeGrowthOutsideX64${side}`].toString()),
      upperOutside: BigInt(upper[`feeGrowthOutsideX64${side}`].toString()),
      lastInside: BigInt(position[`feeGrowthInsideLastX64${side}`].toString()),
      liquidity: BigInt(position.liquidity.toString()),
      owed: BigInt(position[`tokenFeesOwed${side}`].toString()),
    });
  return { a: fee("A"), b: fee("B") };
}

async function walletOwnsNft(connection: Connection, wallet: PublicKey, mint: PublicKey): Promise<boolean> {
  for (const program of [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID]) {
    const ata = getAssociatedTokenAddressSync(mint, wallet, false, program);
    const info = await connection.getAccountInfo(ata, "confirmed");
    if (!info) continue;
    // amount is u64 at offset 64 in SPL token account
    if (info.data.length >= 72) {
      const amount = info.data.readBigUInt64LE(64);
      if (amount === 1n) return true;
    }
  }
  return false;
}

/**
 * Compute holding-period / realized fee APR for a Raydium CLMM position NFT
 * from finalized cached history when enabled, plus fresh on-chain valuation.
 */
export async function getPositionPerformance(
  positionMint: string,
  options: GetPositionPerformanceOptions = {},
): Promise<PositionPerformanceResult> {
  const started = Date.now();
  // A browser refresh after a trade can land on another serverless instance.
  if (options.refreshHistory || options.historyAfterSignatures?.length) resetRpcCache();
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(PERFORMANCE_READ_TIMEOUT_MS)]) : AbortSignal.timeout(PERFORMANCE_READ_TIMEOUT_MS);
  const connection = options.connection ?? rpcConnection(undefined, { signal });
  const maxSignatures = capMaxSignatures(options.maxSignatures);
  const fetcher = options.fetcher ?? fetch;
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);

  const mint = new PublicKey(positionMint);
  const positionPda = getPdaPersonalPositionAddress(CLMM_PROGRAM_ID, mint).publicKey;
  const positionInfo = await connection.getAccountInfo(positionPda, "confirmed");
  if (
    !positionInfo ||
    !positionInfo.owner.equals(CLMM_PROGRAM_ID) ||
    !positionInfo.data.subarray(0, 8).equals(POSITION_DISCRIMINATOR)
  ) {
    throw new Error("Raydium CLMM personal position account not found for this NFT mint");
  }
  const position = PersonalPositionLayout.decode(positionInfo.data);
  if (!position.nftMint.equals(mint)) throw new Error("Position NFT mint mismatch");

  const poolId = position.poolId;
  const poolInfo = await connection.getAccountInfo(poolId, "confirmed");
  if (
    !poolInfo ||
    !poolInfo.owner.equals(CLMM_PROGRAM_ID) ||
    !poolInfo.data.subarray(0, 8).equals(POOL_DISCRIMINATOR)
  ) {
    throw new Error("Pool account missing or not a Raydium CLMM pool");
  }
  const pool = PoolInfoLayout.decode(poolInfo.data);

  const accountsMs = Date.now() - started;
  const provider = options.provider ?? rpcProvider();
  const fallbackConnection = options.fallbackConnection;
  const historyStore = options.historyStore !== undefined ? options.historyStore
    : !options.connection && getRwaConfig().positionHistoryEnabled ? getPositionHistoryStore() : null;
  const [fetched, uncollected, ownsNft] = await Promise.all([loadPerformanceHistory({
    address: positionPda,
    maxSignatures,
    maxDetailRequests: options.connection ? undefined : MAX_PACED_HISTORY_DETAILS,
    connection,
    provider,
    fallbackConnection,
    context: { positionMint, positionAccount: positionPda.toBase58(), poolId: poolId.toBase58(),
      mintA: pool.mintA.toBase58(), mintB: pool.mintB.toBase58(),
      vaultA: pool.vaultA.toBase58(), vaultB: pool.vaultB.toBase58() },
    store: historyStore, signal,
    bypassCache: options.historyMemoryCache === false || options.refreshHistory || Boolean(options.historyAfterSignatures?.length),
    afterSignatures: options.historyAfterSignatures,
    stateFingerprint: createHash("sha256").update(positionInfo.data).digest("hex"),
    connectionsForSignal: !options.connection ? sharedSignal => {
      // Only durable history uses pacing; valuation and transaction RPC keep their own paths.
      const connections = createHistoryRpcConnections(sharedSignal);
      return { connection: connections.connection,
        fallbackConnection: options.fallbackConnection ?? connections.fallbackConnection,
        rpcMetrics: () => connections.observer.snapshot(),
        receiptProvider: (signature: string) => connections.observer.receiptProvider(signature) };
    } : undefined,
  }), readUncollectedFees(connection, CLMM_PROGRAM_ID, poolId, position, pool),
  options.wallet ? walletOwnsNft(connection, new PublicKey(options.wallet), mint) : Promise.resolve(null)]);
  const truncated = fetched.truncated;
  const history: PositionHistoryEvent[] = fetched.history;

  const allEvents = history.flatMap((item) => item.events);
  const cashflows = aggregateCashflowsForPosition(allEvents, positionMint, poolId.toBase58());

  const openedAt =
    history.find((item) => item.events.some((event) => event.kind === "open"))?.blockTime ??
    history[0]?.blockTime ??
    null;
  const holdingSeconds = openedAt !== null && openedAt > 0 ? Math.max(0, nowSeconds - openedAt) : 0;

  const lower = TickUtil.getSqrtPriceAtTick(position.tickLower);
  const upper = TickUtil.getSqrtPriceAtTick(position.tickUpper);
  const currentAmounts = LiquidityMathUtil.getAmountsForLiquidity(
    pool.sqrtPriceX64,
    lower,
    upper,
    position.liquidity,
    false,
  );
  const rangeSide = positionSide(
    BigInt(pool.sqrtPriceX64.toString()),
    BigInt(lower.toString()),
    BigInt(upper.toString()),
  );

  const mintA = pool.mintA.toBase58();
  const mintB = pool.mintB.toBase58();
  const priced = await priceAndLabel({
    mintA, mintB, skipPricing: options.skipPricing, fetcher,
    jupiterApiKey: options.jupiterApiKey, raydiumPoolId: poolId.toBase58(),
  });
  const { priceUsdA, priceUsdB, quotes, pricingMs } = priced;

  const metrics = computePositionPerformance({
    deposited: { a: cashflows.depositedA, b: cashflows.depositedB },
    withdrawnPrincipal: { a: cashflows.withdrawnPrincipalA, b: cashflows.withdrawnPrincipalB },
    feesCollected: { a: cashflows.feesCollectedA, b: cashflows.feesCollectedB },
    liquidityAmounts: {
      a: BigInt(currentAmounts.amountA.toString()),
      b: BigInt(currentAmounts.amountB.toString()),
    },
    uncollectedFees: uncollected,
    holdingSeconds,
    priceUsdA,
    priceUsdB,
    decimalsA: pool.mintDecimalsA,
    decimalsB: pool.mintDecimalsB,
  });

  const metadataStarted = Date.now();
  const { symbolA, symbolB } = await resolveSymbols({
    mintA, mintB, fetcher, jupiterApiKey: options.jupiterApiKey, metadata: "fill-missing",
    prefetch: () => fetchRaydiumPoolSymbols(poolId.toBase58(), fetcher),
  });

  const wrap = matchWrapPairShape(symbolA ?? "", symbolB ?? "");
  const sameAssetWrap = wrap.matched === true;
  const tokenNative = computeTokenNativeMetrics({
    deposited: { a: cashflows.depositedA, b: cashflows.depositedB },
    withdrawnPrincipal: { a: cashflows.withdrawnPrincipalA, b: cashflows.withdrawnPrincipalB },
    feesCollected: { a: cashflows.feesCollectedA, b: cashflows.feesCollectedB },
    liquidityAmounts: {
      a: BigInt(currentAmounts.amountA.toString()),
      b: BigInt(currentAmounts.amountB.toString()),
    },
    uncollectedFees: uncollected,
    holdingDays: metrics.holdingDays,
    decimalsA: pool.mintDecimalsA,
    decimalsB: pool.mintDecimalsB,
    tickCurrent: pool.tickCurrent,
    symbolA,
    symbolB,
    sameAssetWrap,
    wrapKind: sameAssetWrap ? wrap.wrapKind : null,
    wrappedSide: sameAssetWrap ? wrap.wrappedSide : null,
    plainSymbol: sameAssetWrap ? wrap.plainSymbol : null,
    wrappedSymbol: sameAssetWrap ? wrap.wrappedSymbol : null,
  });

  const incomplete = Boolean(historyStore && truncated) || fetched.metric.refreshSignaturesResolved === false;
  return assemblePerformanceResult({
    identity: {
      wallet: options.wallet ?? null,
      ownsNft,
      positionMint,
      positionAccount: positionPda.toBase58(),
      poolId: poolId.toBase58(),
      mintA,
      mintB,
      decimalsA: pool.mintDecimalsA,
      decimalsB: pool.mintDecimalsB,
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      tickCurrent: pool.tickCurrent,
      rangeSide,
      liquidity: position.liquidity.toString(),
      openedAt,
      evaluatedAt: nowSeconds,
      signatureCount: fetched.signatureCount,
      truncated,
      maxSignatures,
      history,
      cashflows: {
        depositedA: cashflows.depositedA.toString(),
        depositedB: cashflows.depositedB.toString(),
        withdrawnPrincipalA: cashflows.withdrawnPrincipalA.toString(),
        withdrawnPrincipalB: cashflows.withdrawnPrincipalB.toString(),
        feesCollectedA: cashflows.feesCollectedA.toString(),
        feesCollectedB: cashflows.feesCollectedB.toString(),
        openCount: cashflows.openCount,
        increaseCount: cashflows.increaseCount,
        decreaseCount: cashflows.decreaseCount,
      },
    },
    metrics,
    tokenNative,
    quotes,
    pricing: { source: priced.pricingSource, label: priced.pricingLabel, priceUsdA, priceUsdB },
    incomplete,
    incompleteMessage: "Position history is incomplete; return percentages are unavailable until backfill and missing transactions are resolved.",
    stockIncomplete: incomplete || truncated || !history.some((item) => item.events.some((event) => event.kind === "open")),
    skipPricing: options.skipPricing,
    fetcher,
    signal,
    uncollectedFees: uncollected,
    historyFetch: fetched.metric,
    started,
    accountsMs,
    pricingMs,
    metadataStarted,
  });
}

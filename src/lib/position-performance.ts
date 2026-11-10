import "@/lib/engine-host";
import "server-only";

import BN from "bn.js";
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
  ASSUMPTIONS_LABEL,
  computePositionPerformance,
  computeTokenNativeMetrics,
  PERFORMANCE_METHOD,
  TOKEN_NATIVE_ASSUMPTIONS,
  type PositionPerformanceMetrics,
  type TokenNativeMetrics,
} from "@sofinance/engine/position-performance-math";
import { matchWrapPairShape } from "./rwa-pairing";
import { JUPITER_PRICE_V3 } from "@sofinance/engine/jupiter/urls";
import { fetchTokenPricesUsd, type TokenPriceQuote, type TokenPriceSource } from "@sofinance/engine/token-prices";
import { buildStockPerformance } from "./stock-performance-build";
import type { StockPerformance } from "./position-performance-report";
import { getTokenMetadata } from "@sofinance/engine/token-metadata";
import {
  buildRealizedFeeAprSeries,
  type RealizedFeeAprSeries,
} from "./realized-fee-apr-series";
import { getJupiterApiKey } from "@sofinance/engine/config/server-env";
import { getRwaConfig } from "./config/rwa-env";
import { getPositionHistoryStore } from "./position-history-store";
import type { PositionHistoryStore } from "./position-history-store-types";
import { loadPerformanceHistory } from "./position-performance-history-load";
import { resetRpcCache } from "@sofinance/engine/rpc/cache";
import { createHistoryRpcConnections } from "./position-history-rpc";

const POSITION_DISCRIMINATOR = createHash("sha256").update("account:PersonalPositionState").digest().subarray(0, 8);
const POOL_DISCRIMINATOR = createHash("sha256").update("account:PoolState").digest().subarray(0, 8);

export const DEFAULT_MAX_SIGNATURES = 100;
// At four public-RPC starts/second, 500 details cannot finish within the shared
// fifty-second deadline. Durable reads checkpoint in bounded chunks instead.
const MAX_PACED_HISTORY_DETAILS = 100;
export { JUPITER_PRICE_V3 };
export const RAYDIUM_POOL_IDS = "https://api-v3.raydium.io/pools/info/ids";

const STABLE_USD_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

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

const PRICE_SOURCE_ID: Record<TokenPriceSource, Exclude<PositionPricingSource, "none" | "dexscreener+jupiter" | "dexscreener+raydium" | "jupiter+raydium" | "dexscreener+jupiter+raydium">> = {
  jupiter: "jupiter-price-v3",
  dexscreener: "dexscreener",
  raydium: "raydium-pool-stable",
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

const PRICE_SOURCE_LABEL: Record<string, string> = {
  "jupiter-price-v3": "USD uses Jupiter Price API v3 at evaluation time (current), NOT historical tx-time prices.",
  dexscreener: "USD uses DexScreener at evaluation time (current), NOT historical tx-time prices. Jupiter Price API v3 was unavailable.",
  "raydium-pool-stable": "USD from Raydium pool mid price with USDC/USDT ≈ $1 fallback (current), NOT historical tx-time prices.",
};

/** Label the actual sources used; never reports Jupiter alone when a fallback filled a mint. */
export function describePositionPricing(
  quoteA: TokenPriceQuote | undefined,
  quoteB: TokenPriceQuote | undefined,
): { source: PositionPricingSource; label: string; priceUsdA: number | null; priceUsdB: number | null } {
  const priceUsdA = quoteA?.price ?? null;
  const priceUsdB = quoteB?.price ?? null;
  if (!quoteA || !quoteB) {
    return { source: "none", label: "USD pricing did not return both mint prices; USD metrics null.", priceUsdA, priceUsdB };
  }
  const unique = [...new Set([quoteA.source, quoteB.source])].sort();
  const source = (unique.length === 1 ? PRICE_SOURCE_ID[unique[0]!] : unique.join("+")) as PositionPricingSource;
  const label = PRICE_SOURCE_LABEL[source] ?? `USD from ${unique.join(" and ")} at evaluation time (current), NOT historical tx-time prices.`;
  return { source, label, priceUsdA, priceUsdB };
}

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

/** Fallback: Raydium pool mid price + $1 stable for USDC/USDT legs. */
async function fetchRaydiumPoolUsdPrices(
  poolId: string,
  mintA: string,
  mintB: string,
  fetcher: typeof fetch,
): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  const url = `${RAYDIUM_POOL_IDS}?ids=${encodeURIComponent(poolId)}`;
  const response = await fetcher(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
  if (!response.ok) return prices;
  const body = (await response.json()) as { data?: Array<{ price?: number | string } | null> };
  const pool = body.data?.[0];
  const ratio = pool?.price !== null && pool?.price !== undefined ? Number(pool.price) : NaN; // tokenA per tokenB? Raydium: price = mintA/mintB quote
  // Raydium docs: `price` is mintA quoted in mintB (how many B per 1 A).
  if (!Number.isFinite(ratio) || ratio <= 0) return prices;
  if (STABLE_USD_MINTS.has(mintB)) {
    prices.set(mintB, 1);
    prices.set(mintA, ratio);
  } else if (STABLE_USD_MINTS.has(mintA)) {
    prices.set(mintA, 1);
    prices.set(mintB, 1 / ratio);
  }
  return prices;
}


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
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(50_000)]) : AbortSignal.timeout(50_000);
  const connection = options.connection ?? rpcConnection(undefined, { signal });
  const maxSignatures = Math.min(Math.max(1, options.maxSignatures ?? DEFAULT_MAX_SIGNATURES), 500);
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

  let priceUsdA: number | null = null;
  let priceUsdB: number | null = null;
  let pricingSource: PositionPricingSource = "none";
  let pricingLabel = "USD pricing skipped; token-raw / token-native metrics only.";
  const pricingStarted = Date.now();
  let quotes = new Map<string, TokenPriceQuote>();
  if (!options.skipPricing) {
    try {
      quotes = await fetchTokenPricesUsd(
        [mintA, mintB],
        fetcher,
        options.jupiterApiKey ?? getJupiterApiKey(),
      );
      let quoteA = quotes.get(mintA);
      let quoteB = quotes.get(mintB);
      if (!quoteA || !quoteB) {
        const fallback = await fetchRaydiumPoolUsdPrices(poolId.toBase58(), mintA, mintB, fetcher);
        const raydium = (mint: string): TokenPriceQuote | undefined => {
          const price = fallback.get(mint);
          return price !== undefined ? { price, source: "raydium" } : undefined;
        };
        quoteA = quoteA ?? raydium(mintA);
        quoteB = quoteB ?? raydium(mintB);
      }
      const described = describePositionPricing(quoteA, quoteB);
      priceUsdA = described.priceUsdA;
      priceUsdB = described.priceUsdB;
      pricingSource = described.source;
      pricingLabel = described.label;
    } catch {
      pricingLabel = "USD pricing request failed; USD metrics null.";
    }
  }

  const pricingMs = Date.now() - pricingStarted;
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

  let symbolA: string | null = null;
  let symbolB: string | null = null;
  const metadataStarted = Date.now();
  try {
    const raySymbols = await fetchRaydiumPoolSymbols(poolId.toBase58(), fetcher);
    symbolA = raySymbols.symbolA;
    symbolB = raySymbols.symbolB;
  } catch {
    /* ignore */
  }
  if (!symbolA || !symbolB) {
    try {
      const meta = await getTokenMetadata(
        [mintA, mintB],
        fetcher,
        options.jupiterApiKey ?? getJupiterApiKey(),
      );
      symbolA = symbolA ?? meta[mintA]?.symbol ?? null;
      symbolB = symbolB ?? meta[mintB]?.symbol ?? null;
    } catch {
      /* ignore */
    }
  }

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
  if (incomplete) {
    metrics.pnlUsd = null;
    metrics.holdingPeriodReturnPct = null;
    metrics.annualizedReturnPct = null;
    metrics.feeOnlyAprPct = null;
    tokenNative.perSideFeeAprPct = { a: null, b: null };
    if (tokenNative.tokenEquivalent) {
      tokenNative.tokenEquivalent.metrics.holdingPeriodReturnPct = null;
      tokenNative.tokenEquivalent.metrics.annualizedReturnPct = null;
      tokenNative.tokenEquivalent.metrics.feeOnlyAprPct = null;
    }
  }
  const assumptions = [ASSUMPTIONS_LABEL, TOKEN_NATIVE_ASSUMPTIONS,
    ...(incomplete ? ["Position history is incomplete; return percentages are unavailable until backfill and missing transactions are resolved."] : [])].join(" ");

  const realizedFeeAprSeries = buildRealizedFeeAprSeries({
    history,
    positionMint,
    poolId: poolId.toBase58(),
    evaluatedAt: nowSeconds,
    uncollectedFees: uncollected,
    priceUsdA,
    priceUsdB,
    decimalsA: pool.mintDecimalsA,
    decimalsB: pool.mintDecimalsB,
    openedAt,
  });
  if (incomplete) realizedFeeAprSeries.points = [];

  const stock = options.skipPricing ? null : await buildStockPerformance({
    history, positionId: positionMint, poolId: poolId.toBase58(), mintA, mintB,
    decimalsA: pool.mintDecimalsA, decimalsB: pool.mintDecimalsB, tokenNative, metrics,
    incomplete: incomplete || truncated || !history.some((item) => item.events.some((event) => event.kind === "open")),
    quotes, nowSeconds, fetcher, signal,
  });

  return {
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
    openedAtIso: openedAt !== null ? new Date(openedAt * 1000).toISOString() : null,
    evaluatedAt: nowSeconds,
    evaluatedAtIso: new Date(nowSeconds * 1000).toISOString(),
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
    metrics,
    tokenNative,
    stock,
    pricing: {
      source: pricingSource,
      label: pricingLabel,
      priceUsdA,
      priceUsdB,
    },
    method: PERFORMANCE_METHOD,
    assumptions,
    realizedFeeAprSeries,
    historyFetch: fetched.metric,
    timings: { totalMs: Date.now() - started, accountsMs, historyMs: fetched.metric.elapsedMs,
      pricingMs, metadataMs: Date.now() - metadataStarted },
  };
}

/** Lightweight re-export for callers that only need BN-backed sqrt helpers in tests. */
export function amountsForLiquidityAtPoolPrice(
  sqrtPriceX64: BN,
  tickLower: number,
  tickUpper: number,
  liquidity: BN,
) {
  return LiquidityMathUtil.getAmountsForLiquidity(
    sqrtPriceX64,
    TickUtil.getSqrtPriceAtTick(tickLower),
    TickUtil.getSqrtPriceAtTick(tickUpper),
    liquidity,
    false,
  );
}

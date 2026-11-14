import "@/lib/engine-host";
import "server-only";

import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { readRaydiumPositionAccounts, readRaydiumUncollectedFees } from "@sofinance/engine/protocols/raydium/position-snapshot";
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
  const snapshot = await readRaydiumPositionAccounts(positionMint, connection);
  const positionPda = new PublicKey(snapshot.positionAccount);

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
    context: { positionMint, positionAccount: snapshot.positionAccount, poolId: snapshot.poolId,
      mintA: snapshot.mintA, mintB: snapshot.mintB,
      vaultA: snapshot.vaultA, vaultB: snapshot.vaultB },
    store: historyStore, signal,
    bypassCache: options.historyMemoryCache === false || options.refreshHistory || Boolean(options.historyAfterSignatures?.length),
    afterSignatures: options.historyAfterSignatures,
    stateFingerprint: snapshot.stateFingerprint,
    connectionsForSignal: !options.connection ? sharedSignal => {
      // Only durable history uses pacing; valuation and transaction RPC keep their own paths.
      const connections = createHistoryRpcConnections(sharedSignal);
      return { connection: connections.connection,
        fallbackConnection: options.fallbackConnection ?? connections.fallbackConnection,
        rpcMetrics: () => connections.observer.snapshot(),
        receiptProvider: (signature: string) => connections.observer.receiptProvider(signature) };
    } : undefined,
  }), readRaydiumUncollectedFees(connection, snapshot),
  options.wallet ? walletOwnsNft(connection, new PublicKey(options.wallet), mint) : Promise.resolve(null)]);
  const truncated = fetched.truncated;
  const history: PositionHistoryEvent[] = fetched.history;

  const allEvents = history.flatMap((item) => item.events);
  const cashflows = aggregateCashflowsForPosition(allEvents, positionMint, snapshot.poolId);

  const openedAt =
    history.find((item) => item.events.some((event) => event.kind === "open"))?.blockTime ??
    history[0]?.blockTime ??
    null;
  const holdingSeconds = openedAt !== null && openedAt > 0 ? Math.max(0, nowSeconds - openedAt) : 0;

  const mintA = snapshot.mintA;
  const mintB = snapshot.mintB;
  const priced = await priceAndLabel({
    mintA, mintB, skipPricing: options.skipPricing, fetcher,
    jupiterApiKey: options.jupiterApiKey, raydiumPoolId: snapshot.poolId,
  });
  const { priceUsdA, priceUsdB, quotes, pricingMs } = priced;

  const metrics = computePositionPerformance({
    deposited: { a: cashflows.depositedA, b: cashflows.depositedB },
    withdrawnPrincipal: { a: cashflows.withdrawnPrincipalA, b: cashflows.withdrawnPrincipalB },
    feesCollected: { a: cashflows.feesCollectedA, b: cashflows.feesCollectedB },
    liquidityAmounts: {
      a: snapshot.amountA,
      b: snapshot.amountB,
    },
    uncollectedFees: uncollected,
    holdingSeconds,
    priceUsdA,
    priceUsdB,
    decimalsA: snapshot.decimalsA,
    decimalsB: snapshot.decimalsB,
  });

  const metadataStarted = Date.now();
  const { symbolA, symbolB } = await resolveSymbols({
    mintA, mintB, fetcher, jupiterApiKey: options.jupiterApiKey, metadata: "fill-missing",
    prefetch: () => fetchRaydiumPoolSymbols(snapshot.poolId, fetcher),
  });

  const wrap = matchWrapPairShape(symbolA ?? "", symbolB ?? "");
  const sameAssetWrap = wrap.matched === true;
  const tokenNative = computeTokenNativeMetrics({
    deposited: { a: cashflows.depositedA, b: cashflows.depositedB },
    withdrawnPrincipal: { a: cashflows.withdrawnPrincipalA, b: cashflows.withdrawnPrincipalB },
    feesCollected: { a: cashflows.feesCollectedA, b: cashflows.feesCollectedB },
    liquidityAmounts: {
      a: snapshot.amountA,
      b: snapshot.amountB,
    },
    uncollectedFees: uncollected,
    holdingDays: metrics.holdingDays,
    decimalsA: snapshot.decimalsA,
    decimalsB: snapshot.decimalsB,
    tickCurrent: snapshot.tickCurrent,
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
      positionAccount: snapshot.positionAccount,
      poolId: snapshot.poolId,
      mintA,
      mintB,
      decimalsA: snapshot.decimalsA,
      decimalsB: snapshot.decimalsB,
      tickLower: snapshot.tickLower,
      tickUpper: snapshot.tickUpper,
      tickCurrent: snapshot.tickCurrent,
      rangeSide: snapshot.rangeSide,
      liquidity: snapshot.liquidity,
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

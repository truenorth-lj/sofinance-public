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
import { accruedFee } from "./compound-math";
import { positionSide } from "./quote-math";
import { defaultRpcConnection, rpcConnection, rpcProvider, type RpcProvider } from "./rpc";
import {
  fetchPositionHistoryTransactions,
  toChronological,
  type CustomRpcCall,
  type HistoryConnection,
  type HistoryFetchMetric,
} from "./position-performance-history";
import {
  aggregateCashflowsForPosition,
  parseRaydiumEventsFromLogs,
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
} from "./position-performance-math";
import { matchWrapPairShape } from "./rwa-pairing";
import { JUPITER_PRICE_V3 } from "./jupiter/urls";
import { fetchJupiterPricesUsd } from "./token-prices";
import { getTokenMetadata } from "./token-metadata";
import {
  buildRealizedFeeAprSeries,
  type RealizedFeeAprSeries,
} from "./realized-fee-apr-series";

const POSITION_DISCRIMINATOR = createHash("sha256").update("account:PersonalPositionState").digest().subarray(0, 8);
const POOL_DISCRIMINATOR = createHash("sha256").update("account:PoolState").digest().subarray(0, 8);

export const DEFAULT_MAX_SIGNATURES = 100;
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
  pricing: {
    source: "jupiter-price-v3" | "raydium-pool-stable" | "none";
    label: string;
    priceUsdA: number | null;
    priceUsdB: number | null;
  };
  method: string;
  assumptions: string;
  /** Sparse cumulative realized fee APR from already-parsed events. Not a daily fill. */
  realizedFeeAprSeries: RealizedFeeAprSeries;
  /** How position history was loaded (batched; Solami getTransactionsForAddress when available). */
  historyFetch: HistoryFetchMetric;
};

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
  /** Override Solami custom RPC (tests). */
  customRpc?: CustomRpcCall;
  /** Non-Solami RPC for history fallback (tests). Defaults to `defaultRpcConnection()`. */
  fallbackConnection?: HistoryConnection;
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
  const response = await fetcher(url, { headers: { Accept: "application/json" } });
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
    const response = await fetcher(url, { headers: { Accept: "application/json" } });
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
 * from on-chain facts only (no database).
 */
export async function getPositionPerformance(
  positionMint: string,
  options: GetPositionPerformanceOptions = {},
): Promise<PositionPerformanceResult> {
  const connection = options.connection ?? rpcConnection();
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

  let ownsNft: boolean | null = null;
  if (options.wallet) {
    ownsNft = await walletOwnsNft(connection, new PublicKey(options.wallet), mint);
  }

  const provider = options.provider ?? rpcProvider();
  const fallbackConnection =
    options.fallbackConnection ??
    (provider === "solami" && !options.connection ? defaultRpcConnection() : undefined);
  const fetched = await fetchPositionHistoryTransactions({
    address: positionPda,
    maxSignatures,
    connection,
    provider,
    customRpc: options.customRpc,
    fallbackConnection,
  });
  const truncated = fetched.truncated;
  const chronological = toChronological(fetched.items);

  const history: PositionHistoryEvent[] = [];
  for (const info of chronological) {
    if (info.err) continue;
    if (!info.logMessages) continue;
    const events = parseRaydiumEventsFromLogs(info.logMessages);
    const relevant = events.filter((event) => {
      if (event.kind === "open") return event.poolState === poolId.toBase58();
      return event.positionNftMint === positionMint;
    });
    if (!relevant.length) continue;
    history.push({
      signature: info.signature,
      blockTime: info.blockTime,
      slot: info.slot,
      events: relevant,
    });
  }

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
  const uncollected = await readUncollectedFees(connection, CLMM_PROGRAM_ID, poolId, position, pool);
  const rangeSide = positionSide(
    BigInt(pool.sqrtPriceX64.toString()),
    BigInt(lower.toString()),
    BigInt(upper.toString()),
  );

  const mintA = pool.mintA.toBase58();
  const mintB = pool.mintB.toBase58();

  let priceUsdA: number | null = null;
  let priceUsdB: number | null = null;
  let pricingSource: "jupiter-price-v3" | "raydium-pool-stable" | "none" = "none";
  let pricingLabel = "USD pricing skipped; token-raw / token-native metrics only.";
  if (!options.skipPricing) {
    try {
      const prices = await fetchJupiterPricesUsd(
        [mintA, mintB],
        fetcher,
        options.jupiterApiKey ?? process.env.JUPITER_API_KEY,
      );
      priceUsdA = prices.get(mintA) ?? null;
      priceUsdB = prices.get(mintB) ?? null;
      if (priceUsdA !== null && priceUsdB !== null) {
        pricingSource = "jupiter-price-v3";
        pricingLabel =
          "USD uses Jupiter Price API v3 at evaluation time (current), NOT historical tx-time prices.";
      } else {
        const fallback = await fetchRaydiumPoolUsdPrices(poolId.toBase58(), mintA, mintB, fetcher);
        priceUsdA = fallback.get(mintA) ?? priceUsdA;
        priceUsdB = fallback.get(mintB) ?? priceUsdB;
        if (priceUsdA !== null && priceUsdB !== null) {
          pricingSource = "raydium-pool-stable";
          pricingLabel =
            "USD from Raydium pool mid price with USDC/USDT ≈ $1 fallback (current), NOT historical tx-time prices. Jupiter Price v3 did not return both mints.";
        } else {
          pricingLabel = "Neither Jupiter Price v3 nor Raydium stable-leg fallback returned both mint prices; USD metrics null.";
        }
      }
    } catch {
      pricingLabel = "USD pricing request failed; USD metrics null.";
    }
  }

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
        options.jupiterApiKey ?? process.env.JUPITER_API_KEY,
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

  const assumptions = [ASSUMPTIONS_LABEL, TOKEN_NATIVE_ASSUMPTIONS].join(" ");

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

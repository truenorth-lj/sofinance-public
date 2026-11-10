import "@/lib/engine-host";
import "server-only";

import { PublicKey, type AccountInfo, type Connection, type GetProgramAccountsConfig } from "@solana/web3.js";
import bs58 from "bs58";
import { decodeLbPair, decodeMintDecimals, meteoraBinArrayAddress, meteoraBinArrayIndexesForRange, type LbPairState } from "@sofinance/engine/protocols/meteora/accounts";
import { METEORA_ALLOWLISTED_POOLS, METEORA_DLMM_PROGRAM_ID } from "@sofinance/engine/protocols/meteora/constants";
import {
  METEORA_POSITION_OWNER_OFFSET, METEORA_POSITION_LB_PAIR_OFFSET, METEORA_POSITION_V2_DISCRIMINATOR, decodeMeteoraPosition,
  isMeteoraPositionAccount, meteoraBinLookup, meteoraPositionLiquidity, meteoraPositionTotals, meteoraRangeSide, type MeteoraPosition,
} from "@sofinance/engine/protocols/meteora/position";
import {
  ASSUMPTIONS_LABEL, computePositionPerformance, computeTokenNativeMetrics, PERFORMANCE_METHOD, TOKEN_NATIVE_ASSUMPTIONS,
} from "@sofinance/engine/position-performance-math";
import { rpcConnection, rpcProvider, type RpcProvider } from "@sofinance/engine/rpc";
import { fetchTokenPricesUsd, type TokenPriceQuote } from "@sofinance/engine/token-prices";
import { buildStockPerformance } from "./stock-performance-build";
import { getTokenMetadata } from "@sofinance/engine/token-metadata";
import { getJupiterApiKey } from "@sofinance/engine/config/server-env";
import { parseMeteoraPositionCashflowEvents, type MeteoraEventContext } from "./meteora-position-events";
import { aggregateCashflowsForPosition } from "./position-performance-events";
import { fetchPositionHistoryTransactions, toChronological, type HistoryConnection } from "./position-performance-history";
import { describePositionPricing, type PositionHistoryEvent, type PositionPerformanceResult } from "./position-performance";
import type { PositionRangeFacts } from "./position-range-onchain";
import { buildRealizedFeeAprSeries } from "./realized-fee-apr-series";
import { matchWrapPairShape } from "./rwa-pairing";

/**
 * Read-only Meteora DLMM positions for the allowlisted pools.
 *
 * A DLMM position is a program account owned by the wallet (no NFT); its
 * address is the position id (`positionMint` in MCP inputs). Like Raydium,
 * every position the wallet owns on-chain in an allowlisted pool is shown,
 * wherever it was opened; nothing here depends on the SoFinance open log.
 * Nothing here builds or signs a transaction.
 */

export const METEORA_PROTOCOL = "meteora-dlmm" as const;
export const METEORA_POOL_NOT_SUPPORTED = "This Meteora position is in a pool SoFinance does not support yet.";
/** Bounds for `meteoraPositionFirstSignature` (used by the open log write path). */
const FIRST_SIGNATURE_PAGE = 1000;
const FIRST_SIGNATURE_MAX_PAGES = 5;
const LIST_MAX_POSITIONS = 50;
const MULTIPLE_ACCOUNTS_BATCH = 100;
/** Discriminator + lb_pair + owner: enough to pick the allowlisted positions before fetching full accounts. */
const POSITION_HEAD_LEN = METEORA_POSITION_OWNER_OFFSET + 32;
const DEFAULT_MAX_SIGNATURES = 100;

type MeteoraConnection = Pick<Connection, "getAccountInfo" | "getMultipleAccountsInfo"> & {
  getProgramAccounts(programId: PublicKey, config: GetProgramAccountsConfig): Promise<ReadonlyArray<{ pubkey: PublicKey; account: { data: Uint8Array } }>>;
};
/** How a pool is listed for SoFinance: its two mints (any order) and, for static allowlist entries, a pinned bin step. */
export type MeteoraPoolListing = { mints: readonly [string, string]; binStep: number | null };
export type MeteoraPoolListingLookup = (poolId: string) => Promise<MeteoraPoolListing | null>;

export type MeteoraReadOptions = {
  connection?: MeteoraConnection;
  /**
   * Which pools count as listed. Default: the static allowlist only (MCP and the legacy UI). The DEX adapter passes the
   * RWA-feed-aware list (`src/lib/dex/meteora-dlmm/pools.server.ts`), which fails closed when the RWA store is off.
   */
  listedPool?: MeteoraPoolListingLookup;
};

const allowlisted = (poolId: string) => METEORA_ALLOWLISTED_POOLS.find((pool) => pool.poolAddress === poolId);
const staticListing: MeteoraPoolListingLookup = async (poolId) => {
  const pool = allowlisted(poolId);
  return pool ? { mints: [pool.mintX, pool.mintY], binStep: pool.binStep } : null;
};

export type MeteoraPositionSnapshot = {
  positionAccount: string;
  poolId: string;
  position: MeteoraPosition;
  pool: LbPairState;
  decimalsX: number;
  decimalsY: number;
  rangeSide: "below" | "inside" | "above";
  amounts: { x: bigint; y: bigint };
  uncollected: { x: bigint; y: bigint };
};

/**
 * Live state of a position account, or null when the address is not a Meteora position. Throws
 * `METEORA_POOL_NOT_SUPPORTED` for a pool `listedPool` does not list (default: the static allowlist).
 */
export async function readMeteoraPositionSnapshot(positionAccount: string, connection: MeteoraConnection,
  listedPool?: MeteoraPoolListingLookup): Promise<MeteoraPositionSnapshot | null> {
  const address = new PublicKey(positionAccount).toBase58();
  const info = await connection.getAccountInfo(new PublicKey(address), "confirmed");
  if (!info || info.owner.toBase58() !== METEORA_DLMM_PROGRAM_ID || !isMeteoraPositionAccount(info.data)) return null;
  const listing = listedPool ? await listedPool(decodeMeteoraPosition(info.data).lbPair) : undefined;
  return snapshotFromData(address, info.data, connection, listing);
}

async function snapshotFromData(positionAccount: string, data: Uint8Array, connection: MeteoraConnection,
  listing?: MeteoraPoolListing | null): Promise<MeteoraPositionSnapshot> {
  const position = decodeMeteoraPosition(data);
  const allow = listing === undefined ? await staticListing(position.lbPair) : listing;
  if (!allow) throw new Error(METEORA_POOL_NOT_SUPPORTED);
  const [listedA, listedB] = allow.mints;
  const indexes = meteoraBinArrayIndexesForRange(position.lowerBinId, position.upperBinId);
  // One batch: pool, both mints, and every bin array the position spans.
  const infos = await connection.getMultipleAccountsInfo(
    [position.lbPair, listedA, listedB, ...indexes.map((index) => meteoraBinArrayAddress(position.lbPair, index))]
      .map((key) => new PublicKey(key)), "confirmed");
  const [poolInfo, mintAInfo, mintBInfo, ...arrayInfos] = infos;
  if (!poolInfo || poolInfo.owner.toBase58() !== METEORA_DLMM_PROGRAM_ID) throw new Error("Meteora LbPair account missing");
  const pool = decodeLbPair(poolInfo.data);
  // Static allowlist entries are in X / Y order with a pinned bin step; feed rows give the two mints in either order.
  const sameMints = pool.tokenXMint === listedA ? pool.tokenYMint === listedB : pool.tokenXMint === listedB && pool.tokenYMint === listedA;
  if (!sameMints || (allow.binStep !== null && (pool.tokenXMint !== listedA || pool.binStep !== allow.binStep))) {
    throw new Error("Meteora LbPair does not match the allowlist");
  }
  const [mintXInfo, mintYInfo] = pool.tokenXMint === listedA ? [mintAInfo, mintBInfo] : [mintBInfo, mintAInfo];
  if (!mintXInfo || !mintYInfo) throw new Error("Meteora pool mint account missing");
  const arrays = new Map<number, Uint8Array>();
  arrayInfos.forEach((arrayInfo, i) => {
    if (arrayInfo && arrayInfo.owner.toBase58() === METEORA_DLMM_PROGRAM_ID) arrays.set(indexes[i]!, arrayInfo.data);
  });
  // A position's bin arrays exist while it exists; missing ones mean we cannot value it.
  const totals = meteoraPositionTotals(position, meteoraBinLookup(arrays));
  return {
    positionAccount, poolId: position.lbPair, position, pool,
    decimalsX: decodeMintDecimals(mintXInfo.data), decimalsY: decodeMintDecimals(mintYInfo.data),
    rangeSide: meteoraRangeSide(pool.activeId, position.lowerBinId, position.upperBinId),
    amounts: { x: totals.amountX, y: totals.amountY }, uncollected: { x: totals.feeX, y: totals.feeY },
  };
}

/** First successful signature of the position account (its open), bounded; null when the history is longer (fail closed). */
export async function meteoraPositionFirstSignature(connection: Pick<Connection, "getSignaturesForAddress">, address: string): Promise<string | null> {
  let before: string | undefined;
  let oldest: string | null = null;
  for (let page = 0; page < FIRST_SIGNATURE_MAX_PAGES; page++) {
    const batch = await connection.getSignaturesForAddress(new PublicKey(address), { limit: FIRST_SIGNATURE_PAGE, before }, "confirmed");
    for (const item of batch) if (!item.err) oldest = item.signature;
    if (batch.length < FIRST_SIGNATURE_PAGE) return oldest;
    before = batch[batch.length - 1]!.signature;
  }
  return null;
}

/** Live snapshot for a position account: null when it is not a Meteora position, throws for a pool SoFinance does not support. */
export async function readMeteoraPosition(positionAccount: string, options: MeteoraReadOptions = {}) {
  const connection = options.connection ?? rpcConnection();
  const snapshot = await readMeteoraPositionSnapshot(positionAccount, connection, options.listedPool);
  return snapshot ? { snapshot, connection } : null;
}

export type MeteoraListedPosition = {
  protocol: typeof METEORA_PROTOCOL;
  /** The position account (Meteora positions have no NFT); pass it as `positionMint` to the position tools. */
  positionMint: string;
  positionAccount: string;
  poolId: string;
  mintA: string;
  mintB: string;
  /** Bin ids map 1:1 to ticks for bin step 1; the range is bins [lowerBinId, upperBinId] = ticks [tickLower, tickUpper). */
  tickLower: number;
  tickUpper: number;
  tickCurrent: number;
  lowerBinId: number;
  upperBinId: number;
  activeBinId: number;
  rangeSide: "below" | "inside" | "above";
  /** Sum of bin liquidity shares (u128, scaled by 2^64). */
  liquidity: string;
  amountsRaw: { a: string; b: string };
  uncollectedFeesRaw: { a: string; b: string };
};

function listedRow(snapshot: MeteoraPositionSnapshot): MeteoraListedPosition {
  const { position, pool } = snapshot;
  return {
    protocol: METEORA_PROTOCOL,
    positionMint: snapshot.positionAccount,
    positionAccount: snapshot.positionAccount,
    poolId: snapshot.poolId,
    mintA: pool.tokenXMint,
    mintB: pool.tokenYMint,
    tickLower: position.lowerBinId,
    tickUpper: position.upperBinId + 1,
    tickCurrent: pool.activeId,
    lowerBinId: position.lowerBinId,
    upperBinId: position.upperBinId,
    activeBinId: pool.activeId,
    rangeSide: snapshot.rangeSide,
    liquidity: meteoraPositionLiquidity(position).toString(),
    amountsRaw: { a: snapshot.amounts.x.toString(), b: snapshot.amounts.y.toString() },
    uncollectedFeesRaw: { a: snapshot.uncollected.x.toString(), b: snapshot.uncollected.y.toString() },
  };
}

/**
 * Meteora positions owned by the wallet in listed pools (`options.listedPool`, default the static allowlist): one
 * getProgramAccounts by discriminator + owner (head bytes only), one listing lookup per distinct pool, then a batched
 * getMultipleAccounts for the listed ones and one batch per position for its pool, mints and bin arrays.
 */
export async function listMeteoraPositions(wallet: string, options: MeteoraReadOptions = {}): Promise<MeteoraListedPosition[]> {
  const owner = new PublicKey(wallet).toBase58();
  const connection = options.connection ?? rpcConnection();
  const discriminator = bs58.encode(Buffer.from(METEORA_POSITION_V2_DISCRIMINATOR, "hex"));
  const heads = await connection.getProgramAccounts(new PublicKey(METEORA_DLMM_PROGRAM_ID), {
    commitment: "confirmed",
    dataSlice: { offset: 0, length: POSITION_HEAD_LEN },
    filters: [
      { memcmp: { offset: 0, bytes: discriminator } },
      { memcmp: { offset: METEORA_POSITION_OWNER_OFFSET, bytes: owner } },
    ],
  });
  const owned = heads.flatMap(({ pubkey, account }) => {
    const data = Buffer.from(account.data);
    if (data.length < POSITION_HEAD_LEN || data.subarray(0, 8).toString("hex") !== METEORA_POSITION_V2_DISCRIMINATOR) return [];
    const lbPair = new PublicKey(data.subarray(METEORA_POSITION_LB_PAIR_OFFSET, METEORA_POSITION_LB_PAIR_OFFSET + 32)).toBase58();
    const holder = new PublicKey(data.subarray(METEORA_POSITION_OWNER_OFFSET, METEORA_POSITION_OWNER_OFFSET + 32)).toBase58();
    return holder === owner ? [{ key: pubkey.toBase58(), lbPair }] : [];
  });
  const listedPool = options.listedPool ?? staticListing;
  const listings = new Map<string, MeteoraPoolListing | null>();
  for (const lbPair of new Set(owned.map((head) => head.lbPair))) listings.set(lbPair, await listedPool(lbPair));
  const candidates = owned.filter((head) => listings.get(head.lbPair)).map((head) => head.key).sort().slice(0, LIST_MAX_POSITIONS);
  if (!candidates.length) return [];
  const infos: Array<AccountInfo<Buffer> | null> = [];
  for (let start = 0; start < candidates.length; start += MULTIPLE_ACCOUNTS_BATCH) {
    infos.push(...await connection.getMultipleAccountsInfo(
      candidates.slice(start, start + MULTIPLE_ACCOUNTS_BATCH).map((key) => new PublicKey(key)), "confirmed"));
  }
  const out: MeteoraListedPosition[] = [];
  for (const [index, info] of infos.entries()) {
    if (!info || info.owner.toBase58() !== METEORA_DLMM_PROGRAM_ID || !isMeteoraPositionAccount(info.data)) continue;
    const position = decodeMeteoraPosition(info.data);
    const listing = listings.get(position.lbPair);
    if (position.owner !== owner || !listing) continue;
    out.push(listedRow(await snapshotFromData(candidates[index]!, info.data, connection, listing)));
  }
  return out;
}

/** UI price (Y per X) of a bin; bin step 1 makes it 1.0001^binId, like a tick. */
function binPriceBPerA(binId: number, binStep: number, decimalsX: number, decimalsY: number) {
  return (1 + binStep / 10_000) ** binId * 10 ** (decimalsX - decimalsY);
}

export type MeteoraPositionRangeFacts = PositionRangeFacts & {
  protocol: typeof METEORA_PROTOCOL;
  lowerBinId: number;
  upperBinId: number;
  activeBinId: number;
  /** Exact price of the active bin; `onChainPriceBPerA` is the active bin's midpoint so a position whose edge bin is active reads in range. */
  activeBinPriceBPerA: number;
};

/**
 * Range facts for `get_position_range_status`, or null when the address is not a Meteora position.
 * Bins [lower, upper] are reported as ticks [lower, upper + 1) (bin step 1 only).
 */
export async function readMeteoraPositionRangeFacts(positionAccount: string, options: MeteoraReadOptions = {}): Promise<MeteoraPositionRangeFacts | null> {
  const read = await readMeteoraPosition(positionAccount, options);
  if (!read) return null;
  const { snapshot } = read;
  const { pool, position } = snapshot;
  if (pool.binStep !== 1) throw new Error("Meteora range status supports bin step 1 pools only");
  const activeBinPriceBPerA = binPriceBPerA(pool.activeId, pool.binStep, snapshot.decimalsX, snapshot.decimalsY);
  const onChainPriceBPerA = binPriceBPerA(pool.activeId + 0.5, pool.binStep, snapshot.decimalsX, snapshot.decimalsY);
  if (!Number.isFinite(onChainPriceBPerA) || onChainPriceBPerA <= 0) throw new Error("On-chain active bin price is not a positive B-per-A value");
  return {
    protocol: METEORA_PROTOCOL,
    positionMint: snapshot.positionAccount,
    poolId: snapshot.poolId,
    mintA: pool.tokenXMint,
    mintB: pool.tokenYMint,
    decimalsA: snapshot.decimalsX,
    decimalsB: snapshot.decimalsY,
    tickLower: position.lowerBinId,
    tickUpper: position.upperBinId + 1,
    tickCurrent: pool.activeId,
    onChainPriceBPerA,
    lowerBinId: position.lowerBinId,
    upperBinId: position.upperBinId,
    activeBinId: pool.activeId,
    activeBinPriceBPerA,
  };
}

export type MeteoraPerformanceOptions = {
  connection?: MeteoraConnection & Pick<Connection, "getSignaturesForAddress" | "getParsedTransaction">;
  wallet?: string;
  maxSignatures?: number;
  skipPricing?: boolean;
  fetcher?: typeof fetch;
  jupiterApiKey?: string;
  nowSeconds?: number;
  provider?: RpcProvider;
  fallbackConnection?: HistoryConnection;
  /**
   * Which pools count as listed (default: the static allowlist); a position in another pool throws
   * `METEORA_POOL_NOT_SUPPORTED` before any history is read. The DEX adapter passes its RWA-feed-aware list.
   */
  listedPool?: MeteoraPoolListingLookup;
};

/**
 * Holding-period / realized fee metrics for a Meteora position in a listed pool, from its
 * landed receipts (DLMM self-CPI events checked against reserve transfers) and
 * live on-chain state. Token X/Y are reported as A/B. Returns null when the
 * address is not a Meteora position.
 */
export async function getMeteoraPositionPerformance(positionAccount: string, options: MeteoraPerformanceOptions = {}): Promise<PositionPerformanceResult | null> {
  const started = Date.now();
  const signal = AbortSignal.timeout(50_000);
  const connection = options.connection ?? rpcConnection(undefined, { signal });
  const read = await readMeteoraPosition(positionAccount, { connection, listedPool: options.listedPool });
  if (!read) return null;
  const { snapshot } = read;
  const accountsMs = Date.now() - started;
  const maxSignatures = Math.min(Math.max(1, options.maxSignatures ?? DEFAULT_MAX_SIGNATURES), 500);
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const fetcher = options.fetcher ?? fetch;
  const { pool, position } = snapshot;
  const context: MeteoraEventContext = {
    positionMint: snapshot.positionAccount, positionAccount: snapshot.positionAccount, poolId: snapshot.poolId,
    mintA: pool.tokenXMint, mintB: pool.tokenYMint, vaultA: pool.reserveX, vaultB: pool.reserveY,
    lowerBinId: position.lowerBinId, upperBinId: position.upperBinId,
  };
  const fetched = await fetchPositionHistoryTransactions({ address: new PublicKey(snapshot.positionAccount), maxSignatures,
    connection, provider: options.provider ?? rpcProvider(), fallbackConnection: options.fallbackConnection });
  const history: PositionHistoryEvent[] = toChronological(fetched.items).flatMap((item) => {
    if (item.err) return [];
    const events = parseMeteoraPositionCashflowEvents(item.parsedTransaction, context);
    return events.length ? [{ signature: item.signature, blockTime: item.blockTime, slot: item.slot, events }] : [];
  });
  const cashflows = aggregateCashflowsForPosition(history.flatMap((item) => item.events), snapshot.positionAccount, snapshot.poolId);
  const opened = history.find((item) => item.events.some((event) => event.kind === "open"));
  const openedAt = opened?.blockTime ?? null;
  const holdingSeconds = openedAt !== null && openedAt > 0 ? Math.max(0, nowSeconds - openedAt) : 0;

  let priceUsdA: number | null = null;
  let priceUsdB: number | null = null;
  let pricingSource: PositionPerformanceResult["pricing"]["source"] = "none";
  let pricingLabel = "USD pricing skipped; token-raw / token-native metrics only.";
  const pricingStarted = Date.now();
  let quotes = new Map<string, TokenPriceQuote>();
  if (!options.skipPricing) {
    try {
      quotes = await fetchTokenPricesUsd([pool.tokenXMint, pool.tokenYMint], fetcher, options.jupiterApiKey ?? getJupiterApiKey());
      const described = describePositionPricing(quotes.get(pool.tokenXMint), quotes.get(pool.tokenYMint));
      priceUsdA = described.priceUsdA;
      priceUsdB = described.priceUsdB;
      pricingSource = described.source;
      pricingLabel = described.label;
    } catch {
      pricingLabel = "USD pricing request failed; USD metrics null.";
    }
  }
  const pricingMs = Date.now() - pricingStarted;
  const sides = {
    deposited: { a: cashflows.depositedA, b: cashflows.depositedB },
    withdrawnPrincipal: { a: cashflows.withdrawnPrincipalA, b: cashflows.withdrawnPrincipalB },
    feesCollected: { a: cashflows.feesCollectedA, b: cashflows.feesCollectedB },
    liquidityAmounts: { a: snapshot.amounts.x, b: snapshot.amounts.y },
    uncollectedFees: { a: snapshot.uncollected.x, b: snapshot.uncollected.y },
  };
  const metrics = computePositionPerformance({ ...sides, holdingSeconds, priceUsdA, priceUsdB,
    decimalsA: snapshot.decimalsX, decimalsB: snapshot.decimalsY });

  const metadataStarted = Date.now();
  // Static allowlist symbols are a fallback only: feed-listed pools are not in it, and token metadata names them.
  const allow = allowlisted(snapshot.poolId);
  let symbolA: string | null = allow?.mintX === pool.tokenXMint ? allow.wrappedSymbol : null;
  let symbolB: string | null = allow?.mintY === pool.tokenYMint ? allow.plainSymbol : null;
  try {
    const meta = await getTokenMetadata([pool.tokenXMint, pool.tokenYMint], fetcher, options.jupiterApiKey ?? getJupiterApiKey());
    symbolA = meta[pool.tokenXMint]?.symbol ?? symbolA;
    symbolB = meta[pool.tokenYMint]?.symbol ?? symbolB;
  } catch { /* allowlist symbols */ }
  const wrap = matchWrapPairShape(symbolA ?? "", symbolB ?? "");
  const sameAssetWrap = wrap.matched === true;
  // Bin step 1: the active bin id is the tick-equivalent price index (1.0001^id).
  const tickCurrent = pool.binStep === 1 ? pool.activeId : 0;
  const tokenNative = computeTokenNativeMetrics({
    ...sides, holdingDays: metrics.holdingDays, decimalsA: snapshot.decimalsX, decimalsB: snapshot.decimalsY,
    tickCurrent, symbolA, symbolB, sameAssetWrap: sameAssetWrap && pool.binStep === 1,
    wrapKind: sameAssetWrap ? wrap.wrapKind : null, wrappedSide: sameAssetWrap ? wrap.wrappedSide : null,
    plainSymbol: sameAssetWrap ? wrap.plainSymbol : null, wrappedSymbol: sameAssetWrap ? wrap.wrappedSymbol : null,
  });

  // Without the open (history longer than the window) the ledger is partial.
  const incomplete = fetched.truncated || !opened;
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
    "Meteora DLMM: token X/Y are reported as A/B; fees are claimed separately from withdrawals; rewards are not included; ledger liquidity is 0 because DLMM events report token amounts, not bin shares.",
    ...(incomplete ? ["Position history is incomplete; return percentages are unavailable until the full history is available."] : [])].join(" ");
  const realizedFeeAprSeries = buildRealizedFeeAprSeries({
    history, positionMint: snapshot.positionAccount, poolId: snapshot.poolId, evaluatedAt: nowSeconds,
    uncollectedFees: { a: snapshot.uncollected.x, b: snapshot.uncollected.y },
    priceUsdA, priceUsdB, decimalsA: snapshot.decimalsX, decimalsB: snapshot.decimalsY, openedAt,
  });
  if (incomplete) realizedFeeAprSeries.points = [];
  const stock = options.skipPricing ? null : await buildStockPerformance({
    history, positionId: snapshot.positionAccount, poolId: snapshot.poolId, mintA: pool.tokenXMint, mintB: pool.tokenYMint,
    decimalsA: snapshot.decimalsX, decimalsB: snapshot.decimalsY, tokenNative, metrics, incomplete, quotes, nowSeconds, fetcher, signal,
  });

  return {
    wallet: options.wallet ?? null,
    ownsNft: options.wallet ? options.wallet === position.owner : null,
    positionMint: snapshot.positionAccount,
    positionAccount: snapshot.positionAccount,
    poolId: snapshot.poolId,
    mintA: pool.tokenXMint,
    mintB: pool.tokenYMint,
    decimalsA: snapshot.decimalsX,
    decimalsB: snapshot.decimalsY,
    tickLower: position.lowerBinId,
    tickUpper: position.upperBinId + 1,
    tickCurrent: pool.activeId,
    rangeSide: snapshot.rangeSide,
    liquidity: meteoraPositionLiquidity(position).toString(),
    openedAt,
    openedAtIso: openedAt !== null ? new Date(openedAt * 1000).toISOString() : null,
    evaluatedAt: nowSeconds,
    evaluatedAtIso: new Date(nowSeconds * 1000).toISOString(),
    signatureCount: fetched.signatureCount,
    truncated: fetched.truncated,
    maxSignatures,
    history,
    cashflows: {
      depositedA: cashflows.depositedA.toString(), depositedB: cashflows.depositedB.toString(),
      withdrawnPrincipalA: cashflows.withdrawnPrincipalA.toString(), withdrawnPrincipalB: cashflows.withdrawnPrincipalB.toString(),
      feesCollectedA: cashflows.feesCollectedA.toString(), feesCollectedB: cashflows.feesCollectedB.toString(),
      openCount: cashflows.openCount, increaseCount: cashflows.increaseCount, decreaseCount: cashflows.decreaseCount,
    },
    metrics,
    tokenNative,
    stock,
    pricing: { source: pricingSource, label: pricingLabel, priceUsdA, priceUsdB },
    method: PERFORMANCE_METHOD,
    assumptions,
    realizedFeeAprSeries,
    historyFetch: fetched.metric,
    timings: { totalMs: Date.now() - started, accountsMs, historyMs: fetched.metric.elapsedMs, pricingMs, metadataMs: Date.now() - metadataStarted },
  };
}

import "@/lib/engine-host";
import "server-only";

import { PublicKey, type Connection, type GetProgramAccountsConfig } from "@solana/web3.js";
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
import { fetchJupiterPricesUsd } from "@sofinance/engine/token-prices";
import { getTokenMetadata } from "@sofinance/engine/token-metadata";
import { getJupiterApiKey } from "@sofinance/engine/config/server-env";
import { getOpensSql, type OpensSql } from "./opens-log/persist";
import { parseMeteoraPositionCashflowEvents, type MeteoraEventContext } from "./meteora-position-events";
import { aggregateCashflowsForPosition } from "./position-performance-events";
import { fetchPositionHistoryTransactions, toChronological, type HistoryConnection } from "./position-performance-history";
import type { PositionHistoryEvent, PositionPerformanceResult } from "./position-performance";
import type { PositionRangeFacts } from "./position-range-onchain";
import { buildRealizedFeeAprSeries } from "./realized-fee-apr-series";
import { matchWrapPairShape } from "./rwa-pairing";

/**
 * Read-only Meteora DLMM positions for the allowlisted pools.
 *
 * A DLMM position is a program account owned by the wallet (no NFT); its
 * address is the position id (`positionMint` in MCP inputs). Same product
 * rule as Orca: a position is shown only when its first successful
 * transaction is a SoFinance-logged open (`sofinance_position_opens`) by the
 * owner in an allowlisted pool. Everything fails closed: no opens database,
 * an unreadable log, a history too long to reach the open, or a
 * non-allowlisted pool all hide it. Nothing here builds or signs a transaction.
 */

export const METEORA_PROTOCOL = "meteora-dlmm" as const;
export const METEORA_NOT_SHOWN = "This Meteora position was not opened through SoFinance; it is not shown yet.";
export const METEORA_OPENS_DB_MISSING = "Meteora positions are unavailable: the SoFinance open log database is not configured on this deployment.";
const PROVENANCE_PAGE = 1000;
const PROVENANCE_MAX_PAGES = 5;
const LIST_MAX_POSITIONS = 50;
const DEFAULT_MAX_SIGNATURES = 100;

type MeteoraConnection = Pick<Connection, "getAccountInfo" | "getMultipleAccountsInfo" | "getSignaturesForAddress"> & {
  getProgramAccounts(programId: PublicKey, config: GetProgramAccountsConfig): Promise<ReadonlyArray<{ pubkey: PublicKey; account: { data: Uint8Array } }>>;
};
export type MeteoraReadOptions = { connection?: MeteoraConnection; sql?: OpensSql | null };

const allowlisted = (poolId: string) => METEORA_ALLOWLISTED_POOLS.find((pool) => pool.poolAddress === poolId);

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

/** Live state of a position account, or null when the address is not a Meteora position. Throws for non-allowlisted pools. */
export async function readMeteoraPositionSnapshot(positionAccount: string, connection: MeteoraConnection): Promise<MeteoraPositionSnapshot | null> {
  const address = new PublicKey(positionAccount).toBase58();
  const info = await connection.getAccountInfo(new PublicKey(address), "confirmed");
  if (!info || info.owner.toBase58() !== METEORA_DLMM_PROGRAM_ID || !isMeteoraPositionAccount(info.data)) return null;
  return snapshotFromData(address, info.data, connection);
}

async function snapshotFromData(positionAccount: string, data: Uint8Array, connection: MeteoraConnection): Promise<MeteoraPositionSnapshot> {
  const position = decodeMeteoraPosition(data);
  const allow = allowlisted(position.lbPair);
  if (!allow) throw new Error(METEORA_NOT_SHOWN);
  const indexes = meteoraBinArrayIndexesForRange(position.lowerBinId, position.upperBinId);
  // One batch: pool, both mints, and every bin array the position spans.
  const infos = await connection.getMultipleAccountsInfo(
    [position.lbPair, allow.mintX, allow.mintY, ...indexes.map((index) => meteoraBinArrayAddress(position.lbPair, index))]
      .map((key) => new PublicKey(key)), "confirmed");
  const [poolInfo, mintXInfo, mintYInfo, ...arrayInfos] = infos;
  if (!poolInfo || poolInfo.owner.toBase58() !== METEORA_DLMM_PROGRAM_ID) throw new Error("Meteora LbPair account missing");
  const pool = decodeLbPair(poolInfo.data);
  if (pool.tokenXMint !== allow.mintX || pool.tokenYMint !== allow.mintY || pool.binStep !== allow.binStep) {
    throw new Error("Meteora LbPair does not match the allowlist");
  }
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

function opensSql(sql: OpensSql | null | undefined) {
  return sql === undefined ? getOpensSql() : sql ?? undefined;
}

/** First successful signature of the position account (its open), bounded; null when the history is longer (fail closed). */
export async function meteoraPositionFirstSignature(connection: Pick<Connection, "getSignaturesForAddress">, address: string): Promise<string | null> {
  let before: string | undefined;
  let oldest: string | null = null;
  for (let page = 0; page < PROVENANCE_MAX_PAGES; page++) {
    const batch = await connection.getSignaturesForAddress(new PublicKey(address), { limit: PROVENANCE_PAGE, before }, "confirmed");
    for (const item of batch) if (!item.err) oldest = item.signature;
    if (batch.length < PROVENANCE_PAGE) return oldest;
    before = batch[batch.length - 1]!.signature;
  }
  return null;
}

/** The SoFinance open log row for this position (logged by its owner), or null (not shown). Never runs DDL. */
export async function meteoraPositionProvenance(
  snapshot: Pick<MeteoraPositionSnapshot, "positionAccount" | "poolId"> & { position: Pick<MeteoraPosition, "owner"> },
  options: { connection: MeteoraConnection; sql?: OpensSql | null },
) {
  const sql = opensSql(options.sql);
  if (!sql || !allowlisted(snapshot.poolId)) return null;
  try {
    const openSignature = await meteoraPositionFirstSignature(options.connection, snapshot.positionAccount);
    if (!openSignature) return null;
    const rows = await sql.unsafe(
      "SELECT wallet FROM sofinance_position_opens WHERE tx_signature = $1 AND pool_address = $2 LIMIT 1",
      [openSignature, snapshot.poolId],
    ) as Array<{ wallet: string }>;
    const row = rows[0];
    return row && row.wallet === snapshot.position.owner ? { openSignature, wallet: row.wallet } : null;
  } catch {
    return null;
  }
}

/** Shown snapshot for a position account: null when it is not a Meteora position, throws when it is one that is not shown. */
export async function readShownMeteoraPosition(positionAccount: string, options: MeteoraReadOptions = {}) {
  const connection = options.connection ?? rpcConnection();
  const snapshot = await readMeteoraPositionSnapshot(positionAccount, connection);
  if (!snapshot) return null;
  const sql = opensSql(options.sql);
  if (!sql) throw new Error(METEORA_OPENS_DB_MISSING);
  const provenance = await meteoraPositionProvenance(snapshot, { connection, sql });
  if (!provenance) throw new Error(METEORA_NOT_SHOWN);
  return { snapshot, provenance, connection };
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
 * Meteora positions owned by the wallet in allowlisted pools (getProgramAccounts by
 * owner + pool), shown only when SoFinance opened them. Throws METEORA_OPENS_DB_MISSING
 * without the open log.
 */
export async function listMeteoraPositions(wallet: string, options: MeteoraReadOptions = {}): Promise<MeteoraListedPosition[]> {
  const sql = opensSql(options.sql);
  // Surfaced by list_positions as a protocolErrors entry instead of a silent empty list.
  if (!sql) throw new Error(METEORA_OPENS_DB_MISSING);
  const owner = new PublicKey(wallet).toBase58();
  const connection = options.connection ?? rpcConnection();
  const discriminator = bs58.encode(Buffer.from(METEORA_POSITION_V2_DISCRIMINATOR, "hex"));
  const found: Array<{ address: string; data: Uint8Array }> = [];
  for (const pool of METEORA_ALLOWLISTED_POOLS) {
    const accounts = await connection.getProgramAccounts(new PublicKey(METEORA_DLMM_PROGRAM_ID), {
      commitment: "confirmed",
      filters: [
        { memcmp: { offset: 0, bytes: discriminator } },
        { memcmp: { offset: METEORA_POSITION_LB_PAIR_OFFSET, bytes: pool.poolAddress } },
        { memcmp: { offset: METEORA_POSITION_OWNER_OFFSET, bytes: owner } },
      ],
    });
    for (const account of accounts) found.push({ address: account.pubkey.toBase58(), data: account.account.data });
  }
  const out: MeteoraListedPosition[] = [];
  for (const item of found.sort((a, b) => a.address.localeCompare(b.address)).slice(0, LIST_MAX_POSITIONS)) {
    if (!isMeteoraPositionAccount(item.data)) continue;
    const position = decodeMeteoraPosition(item.data);
    if (position.owner !== owner || !allowlisted(position.lbPair)) continue;
    const provenance = await meteoraPositionProvenance({ positionAccount: item.address, poolId: position.lbPair, position }, { connection, sql });
    if (!provenance) continue;
    out.push(listedRow(await snapshotFromData(item.address, item.data, connection)));
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
  const shown = await readShownMeteoraPosition(positionAccount, options);
  if (!shown) return null;
  const { snapshot } = shown;
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
  connection?: MeteoraConnection & Pick<Connection, "getParsedTransaction">;
  sql?: OpensSql | null;
  wallet?: string;
  maxSignatures?: number;
  skipPricing?: boolean;
  fetcher?: typeof fetch;
  jupiterApiKey?: string;
  nowSeconds?: number;
  provider?: RpcProvider;
  fallbackConnection?: HistoryConnection;
};

/**
 * Holding-period / realized fee metrics for a shown Meteora position, from its
 * landed receipts (DLMM self-CPI events checked against reserve transfers) and
 * live on-chain state. Token X/Y are reported as A/B. Returns null when the
 * address is not a Meteora position.
 */
export async function getMeteoraPositionPerformance(positionAccount: string, options: MeteoraPerformanceOptions = {}): Promise<PositionPerformanceResult | null> {
  const started = Date.now();
  const signal = AbortSignal.timeout(50_000);
  const connection = options.connection ?? rpcConnection(undefined, { signal });
  const shown = await readShownMeteoraPosition(positionAccount, { connection, sql: options.sql });
  if (!shown) return null;
  const { snapshot } = shown;
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
  if (!options.skipPricing) {
    try {
      const prices = await fetchJupiterPricesUsd([pool.tokenXMint, pool.tokenYMint], fetcher, options.jupiterApiKey ?? getJupiterApiKey());
      priceUsdA = prices.get(pool.tokenXMint) ?? null;
      priceUsdB = prices.get(pool.tokenYMint) ?? null;
      if (priceUsdA !== null && priceUsdB !== null) {
        pricingSource = "jupiter-price-v3";
        pricingLabel = "USD uses Jupiter Price API v3 at evaluation time (current), NOT historical tx-time prices.";
      } else pricingLabel = "Jupiter Price v3 did not return both mint prices; USD metrics null.";
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
  const allow = allowlisted(snapshot.poolId)!;
  let symbolA: string | null = allow.mintX === pool.tokenXMint ? allow.wrappedSymbol : null;
  let symbolB: string | null = allow.mintY === pool.tokenYMint ? allow.plainSymbol : null;
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
  const incomplete = fetched.truncated || !opened || opened.signature !== shown.provenance.openSignature;
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
    pricing: { source: pricingSource, label: pricingLabel, priceUsdA, priceUsdB },
    method: PERFORMANCE_METHOD,
    assumptions,
    realizedFeeAprSeries,
    historyFetch: fetched.metric,
    timings: { totalMs: Date.now() - started, accountsMs, historyMs: fetched.metric.elapsedMs, pricingMs, metadataMs: Date.now() - metadataStarted },
  };
}

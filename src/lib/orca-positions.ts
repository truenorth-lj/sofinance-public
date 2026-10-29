import "@/lib/engine-host";
import "server-only";

import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, type Connection, type ParsedTransactionWithMeta } from "@solana/web3.js";
import bs58 from "bs58";
import { decodeMintDecimals, decodeWhirlpool, orcaTickArrayAddress, orcaTickArrayStartIndex, type WhirlpoolState } from "@sofinance/engine/protocols/orca/accounts";
import { ORCA_ALLOWLISTED_POOLS, ORCA_WHIRLPOOL_PROGRAM_ID } from "@sofinance/engine/protocols/orca/constants";
import {
  decodeOrcaPosition, decodeWhirlpoolFeeGrowth, isOrcaPositionAccount, orcaAmountsForLiquidity, orcaPositionAddress,
  orcaRangeSide, orcaUncollectedFees, readOrcaTickFeeGrowth, type OrcaPosition,
} from "@sofinance/engine/protocols/orca/position";
import {
  ASSUMPTIONS_LABEL, computePositionPerformance, computeTokenNativeMetrics, PERFORMANCE_METHOD, TOKEN_NATIVE_ASSUMPTIONS,
} from "@sofinance/engine/position-performance-math";
import { defaultRpcConnection, rpcConnection, rpcProvider, type RpcProvider } from "@sofinance/engine/rpc";
import { fetchJupiterPricesUsd } from "@sofinance/engine/token-prices";
import { getTokenMetadata } from "@sofinance/engine/token-metadata";
import { getJupiterApiKey } from "@sofinance/engine/config/server-env";
import { getOpensSql, type OpensSql } from "./opens-log/persist";
import { ORCA_INSTRUCTION, parseOrcaPositionCashflowEvents } from "./orca-position-events";
import { aggregateCashflowsForPosition, type PositionEventContext } from "./position-performance-events";
import { fetchPositionHistoryTransactions, toChronological, type HistoryConnection } from "./position-performance-history";
import type { PositionHistoryEvent, PositionPerformanceResult } from "./position-performance";
import type { PositionRangeFacts } from "./position-range-onchain";
import { buildRealizedFeeAprSeries } from "./realized-fee-apr-series";
import { matchWrapPairShape } from "./rwa-pairing";

/**
 * Read-only Orca Whirlpool positions for the allowlisted pools.
 *
 * Product rule: positions opened outside SoFinance are not shown yet. A
 * position is visible only when its first successful transaction is a
 * SoFinance-logged open (`sofinance_position_opens`) in an allowlisted pool.
 * Everything fails closed: no opens database, an unreadable log, a history
 * too long to reach the open, or a non-allowlisted pool all hide it.
 */

export const ORCA_PROTOCOL = "orca-whirlpool" as const;
export const ORCA_NOT_SHOWN = "This Orca position was not opened through SoFinance; it is not shown yet.";
const PROVENANCE_PAGE = 1000;
const PROVENANCE_MAX_PAGES = 5;
const LIST_MAX_OPENS = 50;
const DEFAULT_MAX_SIGNATURES = 100;

type OrcaConnection = Pick<Connection, "getAccountInfo" | "getMultipleAccountsInfo" | "getSignaturesForAddress" | "getParsedTransaction">;
export type OrcaReadOptions = { connection?: OrcaConnection; sql?: OpensSql | null };

const allowlisted = (poolId: string) => ORCA_ALLOWLISTED_POOLS.find((pool) => pool.poolAddress === poolId);

export type OrcaPositionSnapshot = {
  positionMint: string;
  positionAccount: string;
  poolId: string;
  position: OrcaPosition;
  pool: WhirlpoolState;
  decimalsA: number;
  decimalsB: number;
  rangeSide: "below" | "inside" | "above";
  amounts: { a: bigint; b: bigint };
  uncollected: { a: bigint; b: bigint };
  stateFingerprint: string;
};

/** Live position state, or null when the mint has no Orca position account. Throws for non-allowlisted pools. */
export async function readOrcaPositionSnapshot(positionMint: string, connection: OrcaConnection): Promise<OrcaPositionSnapshot | null> {
  const positionAccount = orcaPositionAddress(new PublicKey(positionMint).toBase58());
  const info = await connection.getAccountInfo(new PublicKey(positionAccount), "confirmed");
  if (!info || info.owner.toBase58() !== ORCA_WHIRLPOOL_PROGRAM_ID || !isOrcaPositionAccount(info.data)) return null;
  const position = decodeOrcaPosition(info.data);
  if (position.positionMint !== positionMint) throw new Error("Orca position NFT mint mismatch");
  const allow = allowlisted(position.whirlpool);
  if (!allow) throw new Error(ORCA_NOT_SHOWN);
  return snapshotFromPosition(positionAccount, position, connection, Buffer.from(info.data).toString("base64"));
}

async function snapshotFromPosition(positionAccount: string, position: OrcaPosition, connection: OrcaConnection, fingerprint: string): Promise<OrcaPositionSnapshot> {
  const poolInfo = await connection.getAccountInfo(new PublicKey(position.whirlpool), "confirmed");
  if (!poolInfo || poolInfo.owner.toBase58() !== ORCA_WHIRLPOOL_PROGRAM_ID) throw new Error("Orca whirlpool account missing");
  const pool = decodeWhirlpool(poolInfo.data);
  const growth = decodeWhirlpoolFeeGrowth(poolInfo.data);
  const allow = allowlisted(position.whirlpool)!;
  if (pool.tokenMintA !== allow.mintA || pool.tokenMintB !== allow.mintB) throw new Error("Orca whirlpool mints do not match the allowlist");
  const ticks = [position.tickLowerIndex, position.tickUpperIndex];
  const arrays = ticks.map((tick) => orcaTickArrayAddress(position.whirlpool, orcaTickArrayStartIndex(tick, pool.tickSpacing)));
  const infos = await connection.getMultipleAccountsInfo(
    [...arrays, pool.tokenMintA, pool.tokenMintB].map((address) => new PublicKey(address)), "confirmed");
  const [lowerInfo, upperInfo, mintAInfo, mintBInfo] = infos;
  if (!lowerInfo || !upperInfo || lowerInfo.owner.toBase58() !== ORCA_WHIRLPOOL_PROGRAM_ID || upperInfo.owner.toBase58() !== ORCA_WHIRLPOOL_PROGRAM_ID) {
    throw new Error("Orca boundary tick array missing for fee accrual");
  }
  if (!mintAInfo || !mintBInfo) throw new Error("Orca pool mint account missing");
  const lower = readOrcaTickFeeGrowth(lowerInfo.data, pool.tickSpacing, position.tickLowerIndex);
  const upper = readOrcaTickFeeGrowth(upperInfo.data, pool.tickSpacing, position.tickUpperIndex);
  if (position.liquidity > 0n && (!lower.initialized || !upper.initialized)) throw new Error("Orca boundary tick not initialized");
  const fees = orcaUncollectedFees({ tickCurrentIndex: pool.tickCurrentIndex, feeGrowth: growth, position, lower, upper });
  const amounts = orcaAmountsForLiquidity(position.liquidity, pool.sqrtPriceX64, position.tickLowerIndex, position.tickUpperIndex);
  return {
    positionMint: position.positionMint, positionAccount, poolId: position.whirlpool, position, pool,
    decimalsA: decodeMintDecimals(mintAInfo.data), decimalsB: decodeMintDecimals(mintBInfo.data),
    rangeSide: orcaRangeSide(pool.sqrtPriceX64, position.tickLowerIndex, position.tickUpperIndex),
    amounts: { a: amounts.amountA, b: amounts.amountB }, uncollected: { a: fees.feeA, b: fees.feeB },
    stateFingerprint: fingerprint,
  };
}

function opensSql(sql: OpensSql | null | undefined) {
  return sql === undefined ? getOpensSql() : sql ?? undefined;
}

/**
 * First successful signature of the position account (its open), bounded.
 * Returns null when the history is longer than the bound (fail closed).
 */
async function firstSuccessfulSignature(connection: OrcaConnection, address: string): Promise<string | null> {
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

/** The SoFinance open log row for this position, or null (not shown). Never runs DDL. */
export async function orcaPositionProvenance(snapshot: Pick<OrcaPositionSnapshot, "positionAccount" | "poolId">, options: { connection: OrcaConnection; sql?: OpensSql | null }) {
  const sql = opensSql(options.sql);
  if (!sql || !allowlisted(snapshot.poolId)) return null;
  try {
    const openSignature = await firstSuccessfulSignature(options.connection, snapshot.positionAccount);
    if (!openSignature) return null;
    const rows = await sql.unsafe(
      "SELECT wallet FROM sofinance_position_opens WHERE tx_signature = $1 AND pool_address = $2 LIMIT 1",
      [openSignature, snapshot.poolId],
    ) as Array<{ wallet: string }>;
    return rows[0] ? { openSignature, wallet: rows[0].wallet } : null;
  } catch {
    return null;
  }
}

/** Shown Orca snapshot for a mint: null when it is not an Orca position, throws when it is one that is not shown. */
export async function readShownOrcaPosition(positionMint: string, options: OrcaReadOptions = {}) {
  const connection = options.connection ?? rpcConnection();
  const snapshot = await readOrcaPositionSnapshot(positionMint, connection);
  if (!snapshot) return null;
  const provenance = await orcaPositionProvenance(snapshot, { connection, sql: options.sql });
  if (!provenance) throw new Error(ORCA_NOT_SHOWN);
  return { snapshot, provenance, connection };
}

async function walletHoldsNft(connection: OrcaConnection, wallet: string, mint: string): Promise<boolean> {
  const owner = new PublicKey(wallet);
  const atas = [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID].map((program) => getAssociatedTokenAddressSync(new PublicKey(mint), owner, true, program));
  const infos = await connection.getMultipleAccountsInfo(atas, "confirmed");
  return infos.some((info) => Boolean(info && info.data.length >= 72 && new PublicKey(info.data.subarray(32, 64)).equals(owner) &&
    info.data.readBigUInt64LE(64) === 1n));
}

/** Position mint opened by an Orca open instruction in this transaction for `wallet`, in an allowlisted pool. */
function openedOrcaPosition(transaction: ParsedTransactionWithMeta | null, wallet: string): { positionMint: string; poolId: string } | null {
  if (!transaction?.meta || transaction.meta.err) return null;
  const opens: Record<string, number> = {
    [ORCA_INSTRUCTION.openPosition]: 5, [ORCA_INSTRUCTION.openPositionWithMetadata]: 6, [ORCA_INSTRUCTION.openPositionWithTokenExtensions]: 5,
  };
  for (const instruction of transaction.transaction.message.instructions) {
    if (instruction.programId.toBase58() !== ORCA_WHIRLPOOL_PROGRAM_ID || !("accounts" in instruction)) continue;
    let disc: string;
    try { disc = Buffer.from(bs58.decode(instruction.data)).subarray(0, 8).toString("hex"); } catch { continue; }
    const whirlpoolIndex = opens[disc];
    if (whirlpoolIndex === undefined) continue;
    const poolId = instruction.accounts[whirlpoolIndex]?.toBase58();
    const positionMint = instruction.accounts[3]?.toBase58();
    if (poolId && positionMint && allowlisted(poolId) && instruction.accounts[1]?.toBase58() === wallet) return { positionMint, poolId };
  }
  return null;
}

export type OrcaListedPosition = {
  protocol: typeof ORCA_PROTOCOL;
  positionMint: string;
  positionAccount: string;
  poolId: string;
  mintA: string;
  mintB: string;
  tickLower: number;
  tickUpper: number;
  tickCurrent: number;
  rangeSide: "below" | "inside" | "above";
  liquidity: string;
};

/** Orca positions the wallet opened through SoFinance in allowlisted pools and still holds. */
export async function listOrcaPositions(wallet: string, options: OrcaReadOptions = {}): Promise<OrcaListedPosition[]> {
  const sql = opensSql(options.sql);
  if (!sql) return [];
  const owner = new PublicKey(wallet).toBase58();
  const connection = options.connection ?? rpcConnection();
  const rows = await sql.unsafe(
    `SELECT tx_signature FROM sofinance_position_opens
     WHERE wallet = $1 AND pool_address = ANY($2::text[]) ORDER BY opened_at DESC LIMIT ${LIST_MAX_OPENS}`,
    [owner, ORCA_ALLOWLISTED_POOLS.map((pool) => pool.poolAddress)],
  ) as Array<{ tx_signature: string }>;
  const out: OrcaListedPosition[] = [];
  for (const row of rows) {
    const transaction = await connection.getParsedTransaction(row.tx_signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    const opened = openedOrcaPosition(transaction, owner);
    if (!opened || out.some((item) => item.positionMint === opened.positionMint)) continue;
    const snapshot = await readOrcaPositionSnapshot(opened.positionMint, connection);
    if (!snapshot || !(await walletHoldsNft(connection, owner, snapshot.positionMint))) continue;
    // The logged transaction must be this position's open, not merely one that names it.
    const provenance = await orcaPositionProvenance(snapshot, { connection, sql });
    if (provenance?.openSignature !== row.tx_signature) continue;
    out.push(listedRow(snapshot));
  }
  return out;
}

function listedRow(snapshot: OrcaPositionSnapshot): OrcaListedPosition {
  return {
    protocol: ORCA_PROTOCOL,
    positionMint: snapshot.positionMint,
    positionAccount: snapshot.positionAccount,
    poolId: snapshot.poolId,
    mintA: snapshot.pool.tokenMintA,
    mintB: snapshot.pool.tokenMintB,
    tickLower: snapshot.position.tickLowerIndex,
    tickUpper: snapshot.position.tickUpperIndex,
    tickCurrent: snapshot.pool.tickCurrentIndex,
    rangeSide: snapshot.rangeSide,
    liquidity: snapshot.position.liquidity.toString(),
  };
}

function onChainPriceBPerA(sqrtPriceX64: bigint, decimalsA: number, decimalsB: number) {
  const ratio = Number(sqrtPriceX64) / 2 ** 64;
  return ratio * ratio * 10 ** (decimalsA - decimalsB);
}

/** Range facts for `get_position_range_status`, or null when the mint is not an Orca position. */
export async function readOrcaPositionRangeFacts(positionMint: string, options: OrcaReadOptions = {}): Promise<PositionRangeFacts | null> {
  const shown = await readShownOrcaPosition(positionMint, options);
  if (!shown) return null;
  const { snapshot } = shown;
  const price = onChainPriceBPerA(snapshot.pool.sqrtPriceX64, snapshot.decimalsA, snapshot.decimalsB);
  if (!Number.isFinite(price) || price <= 0) throw new Error("On-chain pool mid price is not a positive B-per-A value");
  return {
    positionMint,
    poolId: snapshot.poolId,
    mintA: snapshot.pool.tokenMintA,
    mintB: snapshot.pool.tokenMintB,
    decimalsA: snapshot.decimalsA,
    decimalsB: snapshot.decimalsB,
    tickLower: snapshot.position.tickLowerIndex,
    tickUpper: snapshot.position.tickUpperIndex,
    tickCurrent: snapshot.pool.tickCurrentIndex,
    onChainPriceBPerA: price,
  };
}

export type OrcaPerformanceOptions = OrcaReadOptions & {
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
 * Holding-period / realized fee metrics for a shown Orca position, from its
 * landed receipts (no durable history store yet) and live on-chain state.
 * Returns null when the mint is not an Orca position.
 */
export async function getOrcaPositionPerformance(positionMint: string, options: OrcaPerformanceOptions = {}): Promise<PositionPerformanceResult | null> {
  const started = Date.now();
  const signal = AbortSignal.timeout(50_000);
  const connection = options.connection ?? rpcConnection(undefined, { signal });
  const shown = await readShownOrcaPosition(positionMint, { connection, sql: options.sql });
  if (!shown) return null;
  const { snapshot } = shown;
  const accountsMs = Date.now() - started;
  const maxSignatures = Math.min(Math.max(1, options.maxSignatures ?? DEFAULT_MAX_SIGNATURES), 500);
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const fetcher = options.fetcher ?? fetch;
  const provider = options.provider ?? rpcProvider();
  const fallbackConnection = options.fallbackConnection ??
    (provider === "solami" && !options.connection ? defaultRpcConnection(undefined, { signal }) : undefined);
  const { pool } = snapshot;
  const context: PositionEventContext = {
    positionMint, positionAccount: snapshot.positionAccount, poolId: snapshot.poolId,
    mintA: pool.tokenMintA, mintB: pool.tokenMintB, vaultA: pool.tokenVaultA, vaultB: pool.tokenVaultB,
  };
  const [fetched, ownsNft] = await Promise.all([
    fetchPositionHistoryTransactions({ address: new PublicKey(snapshot.positionAccount), maxSignatures, connection, provider, fallbackConnection }),
    options.wallet ? walletHoldsNft(connection, options.wallet, positionMint) : Promise.resolve(null),
  ]);
  const history: PositionHistoryEvent[] = toChronological(fetched.items).flatMap((item) => {
    if (item.err) return [];
    const events = parseOrcaPositionCashflowEvents(item.logMessages, item.parsedTransaction, context);
    return events.length ? [{ signature: item.signature, blockTime: item.blockTime, slot: item.slot, events }] : [];
  });
  const cashflows = aggregateCashflowsForPosition(history.flatMap((item) => item.events), positionMint, snapshot.poolId);
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
      const prices = await fetchJupiterPricesUsd([pool.tokenMintA, pool.tokenMintB], fetcher, options.jupiterApiKey ?? getJupiterApiKey());
      priceUsdA = prices.get(pool.tokenMintA) ?? null;
      priceUsdB = prices.get(pool.tokenMintB) ?? null;
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
    liquidityAmounts: snapshot.amounts,
    uncollectedFees: snapshot.uncollected,
  };
  const metrics = computePositionPerformance({ ...sides, holdingSeconds, priceUsdA, priceUsdB,
    decimalsA: snapshot.decimalsA, decimalsB: snapshot.decimalsB });

  const metadataStarted = Date.now();
  const allow = allowlisted(snapshot.poolId)!;
  let symbolA: string | null = allow.mintA === pool.tokenMintA ? allow.wrappedSymbol : null;
  let symbolB: string | null = allow.mintB === pool.tokenMintB ? allow.plainSymbol : null;
  try {
    const meta = await getTokenMetadata([pool.tokenMintA, pool.tokenMintB], fetcher, options.jupiterApiKey ?? getJupiterApiKey());
    symbolA = meta[pool.tokenMintA]?.symbol ?? symbolA;
    symbolB = meta[pool.tokenMintB]?.symbol ?? symbolB;
  } catch { /* allowlist symbols */ }
  const wrap = matchWrapPairShape(symbolA ?? "", symbolB ?? "");
  const sameAssetWrap = wrap.matched === true;
  const tokenNative = computeTokenNativeMetrics({
    ...sides, holdingDays: metrics.holdingDays, decimalsA: snapshot.decimalsA, decimalsB: snapshot.decimalsB,
    tickCurrent: pool.tickCurrentIndex, symbolA, symbolB, sameAssetWrap,
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
  const assumptions = [ASSUMPTIONS_LABEL, TOKEN_NATIVE_ASSUMPTIONS, "Orca: fees are collected separately from withdrawals; rewards are not included.",
    ...(incomplete ? ["Position history is incomplete; return percentages are unavailable until the full history is available."] : [])].join(" ");
  const realizedFeeAprSeries = buildRealizedFeeAprSeries({
    history, positionMint, poolId: snapshot.poolId, evaluatedAt: nowSeconds, uncollectedFees: snapshot.uncollected,
    priceUsdA, priceUsdB, decimalsA: snapshot.decimalsA, decimalsB: snapshot.decimalsB, openedAt,
  });
  if (incomplete) realizedFeeAprSeries.points = [];

  return {
    wallet: options.wallet ?? null,
    ownsNft,
    positionMint,
    positionAccount: snapshot.positionAccount,
    poolId: snapshot.poolId,
    mintA: pool.tokenMintA,
    mintB: pool.tokenMintB,
    decimalsA: snapshot.decimalsA,
    decimalsB: snapshot.decimalsB,
    tickLower: snapshot.position.tickLowerIndex,
    tickUpper: snapshot.position.tickUpperIndex,
    tickCurrent: pool.tickCurrentIndex,
    rangeSide: snapshot.rangeSide,
    liquidity: snapshot.position.liquidity.toString(),
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

import "@/lib/engine-host";
import { discoverWallet } from "@sofinance/engine/wallet-discovery";
import { sanitizePublicError } from "../../lib/public-error";
import { getPositionPerformance as readPositionPerformance } from "../../lib/position-performance";
import { readPositionRangeFacts } from "../../lib/position-range-onchain";
import { isMeteoraDlmmDiscoveryEnabled, isOrcaPositionsEnabled } from "../../lib/protocol-flags";
import {
  getOrcaPositionPerformance,
  listOrcaPositions,
  ORCA_PROTOCOL,
  positionMintLooksLikeOrca,
  readOrcaPositionRangeFacts,
} from "../../lib/orca-positions";
import {
  getMeteoraPositionPerformance,
  listMeteoraPositions,
  METEORA_PROTOCOL,
  positionAccountLooksLikeMeteora,
  readMeteoraPositionRangeFacts,
} from "../../lib/meteora-positions";
import { rangeStatusFromPrice } from "../../lib/position-range-status";
import type {
  GetPositionPerformanceInput,
  GetPositionRangeStatusInput,
  ListPositionsInput,
} from "../schemas";

export type PerformanceSource = "orca" | "meteora" | "raydium";

/**
 * Resolve which DEX reader should serve a performance or range-status request.
 * Orca (when enabled) is recognised by its position PDA; Meteora (when enabled)
 * by the position account itself. Anything else is Raydium. Flags stay fail-closed:
 * production never looks at or calls the Orca or Meteora readers.
 */
export async function performanceSourceFor(positionMint: string): Promise<PerformanceSource> {
  if (isOrcaPositionsEnabled() && await positionMintLooksLikeOrca(positionMint)) return "orca";
  if (isMeteoraDlmmDiscoveryEnabled() && await positionAccountLooksLikeMeteora(positionMint)) return "meteora";
  return "raydium";
}

/**
 * List a wallet's positions and assets: Raydium CLMM position NFTs, plus (behind their
 * flags) Orca Whirlpool position NFTs and Meteora DLMM position accounts the wallet holds
 * on-chain in allowlisted pools, wherever they were opened. Also returns eligible assets and balances.
 * 
 * Safety: Read-only operation, no private keys required.
 */
export async function listPositions(input: ListPositionsInput) {
  const orca = isOrcaPositionsEnabled() ? listOrcaPositions(input.wallet).then(
    (positions) => ({ positions, error: null }),
    (error: unknown) => ({ positions: [], error: sanitizePublicError(error, "Orca positions are unavailable right now.") }),
  ) : null;
  // Meteora DLMM positions (flagged off in production): read-only, every wallet-owned position in allowlisted pools.
  const meteora = isMeteoraDlmmDiscoveryEnabled() ? listMeteoraPositions(input.wallet).then(
    (positions) => ({ positions, error: null }),
    (error: unknown) => ({ positions: [], error: sanitizePublicError(error, "Meteora positions are unavailable right now.") }),
  ) : null;
  const discovery = await discoverWallet(input.wallet);
  const orcaResult = orca ? await orca : null;
  const meteoraResult = meteora ? await meteora : null;
  const protocolErrors = [
    ...(orcaResult?.error ? [{ protocol: ORCA_PROTOCOL, error: orcaResult.error }] : []),
    ...(meteoraResult?.error ? [{ protocol: METEORA_PROTOCOL, error: meteoraResult.error }] : []),
  ];

  return {
    wallet: discovery.wallet,
    slot: discovery.slot,
    fetchedAt: discovery.fetchedAt,
    positions: [...discovery.positions.map(pos => ({
      positionMint: pos.positionMint,
      positionAccount: pos.positionAccount,
      poolId: pos.poolId,
      mintA: pos.mintA,
      mintB: pos.mintB,
      tickLower: pos.tickLower,
      tickUpper: pos.tickUpper,
      tickCurrent: pos.tickCurrent,
      rangeSide: pos.rangeSide,
      liquidity: pos.liquidity,
    })), ...(orcaResult?.positions ?? []), ...(meteoraResult?.positions ?? [])],
    ...(protocolErrors.length ? { protocolErrors } : {}),
    assets: discovery.assets.map(asset => ({
      kind: asset.kind,
      mint: asset.mint,
      tokenProgram: asset.tokenProgram,
      decimals: asset.decimals,
      balance: asset.balance,
      totalBalance: asset.totalBalance,
      account: asset.account,
      eligible: asset.eligible,
      reason: asset.reason,
    })),
  };
}


/**
 * Holding-period / realized fee metrics for a position. The DEX is resolved once
 * via `performanceSourceFor` (Orca, then Meteora, then Raydium) so the other
 * readers are not probed.
 */
export async function getPositionPerformance(input: GetPositionPerformanceInput) {
  const source = await performanceSourceFor(input.positionMint);
  const orca = isOrcaPositionsEnabled() && source === "orca" ? await getOrcaPositionPerformance(input.positionMint, {
    wallet: input.wallet,
    maxSignatures: input.maxSignatures,
    skipPricing: input.skipPricing,
  }) : null;
  const meteora = isMeteoraDlmmDiscoveryEnabled() && source === "meteora" ? await getMeteoraPositionPerformance(input.positionMint, { wallet: input.wallet, maxSignatures: input.maxSignatures, skipPricing: input.skipPricing }) : null;
  const result = orca ?? meteora ?? await readPositionPerformance(input.positionMint, {
    wallet: input.wallet,
    maxSignatures: input.maxSignatures,
    skipPricing: input.skipPricing,
    refreshHistory: input.refreshHistory,
    historyAfterSignatures: input.historyAfterSignatures,
  });

  return {
    ...(orca ? { protocol: ORCA_PROTOCOL } : meteora ? { protocol: METEORA_PROTOCOL } : {}),
    wallet: result.wallet,
    ownsNft: result.ownsNft,
    positionMint: result.positionMint,
    positionAccount: result.positionAccount,
    poolId: result.poolId,
    mintA: result.mintA,
    mintB: result.mintB,
    decimalsA: result.decimalsA,
    decimalsB: result.decimalsB,
    tickLower: result.tickLower,
    tickUpper: result.tickUpper,
    tickCurrent: result.tickCurrent,
    rangeSide: result.rangeSide,
    liquidity: result.liquidity,
    openedAt: result.openedAt,
    openedAtIso: result.openedAtIso,
    evaluatedAt: result.evaluatedAt,
    evaluatedAtIso: result.evaluatedAtIso,
    signatureCount: result.signatureCount,
    truncated: result.truncated,
    maxSignatures: result.maxSignatures,
    cashflows: result.cashflows,
    metrics: {
      holdingDays: result.metrics.holdingDays,
      depositedRaw: result.metrics.depositedRaw,
      withdrawnPrincipalRaw: result.metrics.withdrawnPrincipalRaw,
      feesCollectedRaw: result.metrics.feesCollectedRaw,
      uncollectedFeesRaw: result.metrics.uncollectedFeesRaw,
      liquidityAmountsRaw: result.metrics.liquidityAmountsRaw,
      currentEquityRaw: result.metrics.currentEquityRaw,
      feesEarnedRaw: result.metrics.feesEarnedRaw,
      pnlRaw: result.metrics.pnlRaw,
      priceUsdA: result.metrics.priceUsdA,
      priceUsdB: result.metrics.priceUsdB,
      depositedUsd: result.metrics.depositedUsd,
      withdrawnPrincipalUsd: result.metrics.withdrawnPrincipalUsd,
      feesCollectedUsd: result.metrics.feesCollectedUsd,
      uncollectedFeesUsd: result.metrics.uncollectedFeesUsd,
      feesEarnedUsd: result.metrics.feesEarnedUsd,
      liquidityUsd: result.metrics.liquidityUsd,
      currentEquityUsd: result.metrics.currentEquityUsd,
      pnlUsd: result.metrics.pnlUsd,
      holdingPeriodReturnPct: result.metrics.holdingPeriodReturnPct,
      annualizedReturnPct: result.metrics.annualizedReturnPct,
      feeOnlyAprPct: result.metrics.feeOnlyAprPct,
    },
    tokenNative: result.tokenNative,
    history: result.history.map((item) => ({
      signature: item.signature,
      blockTime: item.blockTime,
      slot: item.slot,
      events: item.events,
    })),
    pricing: result.pricing,
    method: result.method,
    assumptions: result.assumptions,
    realizedFeeAprSeries: result.realizedFeeAprSeries,
    historyFetch: result.historyFetch,
    timings: result.timings,
  };
}

/**
 * In/out-of-range status from the current on-chain pool price versus position
 * ticks. Read-only.
 */
export async function getPositionRangeStatus(input: GetPositionRangeStatusInput) {
  const source = await performanceSourceFor(input.positionMint);
  const orcaFacts = isOrcaPositionsEnabled() && source === "orca" ? await readOrcaPositionRangeFacts(input.positionMint) : null;
  const meteoraFacts = isMeteoraDlmmDiscoveryEnabled() && source === "meteora" ? await readMeteoraPositionRangeFacts(input.positionMint) : null;
  const facts = orcaFacts ?? meteoraFacts ?? await readPositionRangeFacts(input.positionMint);
  const status = rangeStatusFromPrice({
    priceBPerA: facts.onChainPriceBPerA,
    tickLower: facts.tickLower,
    tickUpper: facts.tickUpper,
    decimalsA: facts.decimalsA,
    decimalsB: facts.decimalsB,
    priceSource: "on-chain",
  });
  return {
    ...(orcaFacts ? { protocol: ORCA_PROTOCOL } : {}),
    wallet: input.wallet ?? null,
    ...facts,
    ...(meteoraFacts ? { protocol: METEORA_PROTOCOL } : {}),
    poolId: input.poolId ?? facts.poolId,
    ...status,
  };
}

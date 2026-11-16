import "@/lib/engine-host";
import { listNativeWalletPositions, nativePositionPerformance, nativePositionRangeStatus } from "@/lib/dex";
export { nativePositionSourceFor as performanceSourceFor } from "@/lib/dex";
export type { NativePositionSource as PerformanceSource } from "@/lib/dex";
import type {
  GetPositionPerformanceInput,
  GetPositionRangeStatusInput,
  ListPositionsInput,
} from "../schemas";

/**
 * List a wallet's positions and assets: Raydium CLMM position NFTs, plus (behind their
 * flags) Orca Whirlpool position NFTs and Meteora DLMM position accounts the wallet holds
 * on-chain in allowlisted pools, wherever they were opened. Also returns eligible assets and balances.
 * 
 * Safety: Read-only operation, no private keys required.
 */
export async function listPositions(input: ListPositionsInput) {
  return listNativeWalletPositions(input);
}


/**
 * Holding-period / realized fee metrics for a position. The DEX is resolved once
 * via `performanceSourceFor` (Orca, then Meteora, then Raydium) so the other
 * readers are not probed.
 */
export async function getPositionPerformance(input: GetPositionPerformanceInput) {
  const { result, protocol } = await nativePositionPerformance(input);

  return {
    ...(protocol ? { protocol } : {}),
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
  return nativePositionRangeStatus(input);
}

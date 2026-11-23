import { aprWindowAvgLabel } from "@/lib/lp-plan-best-apr";
import { planPoolTerms, projectPoolPlanInAsset } from "@/lib/lp-plan-pool-terms";
import { pairLabelSymbols, planAssetSymbol, planShareSymbol } from "@/lib/lp-plan-shares";
import { planDataNotice } from "@/lib/lp-plan-notice";
import { dexDescriptors, uiFor } from "@/lib/dex/client";
import type { AmountUnit } from "./format";
import type { PoolYieldState } from "./use-pool-yield";

/** What a pool needs to be projected: the same fields the Calculate dialog reads from a pool card. */
export type PlanBasisPool = {
  pairLabel: string;
  protocol: string;
  /** Pool TVL from the list, used to split the pool's fees with your deposit; the daily data's newest TVL otherwise. */
  tvlUsd?: number | null;
  /** USD per real share from the pools snapshot (X3 valuation, `withUsdPerShare`); absent when unknown, never guessed. */
  usdPerShare?: number | null;
};

/**
 * Everything the projection of one pool rests on, shared by the Calculate dialog and the homepage estimator (SP-2) so
 * both read the same numbers: the asset it is counted in, the DEX's plan terms, the exit (keep the pool tokens), the TVL
 * the pool's fees are split by, and the best 7 / 30 / 90-day average from `usePoolYield` (`selectBestPlanApr`). Too few
 * days of data (`planDataNotice` "hide") leave `best` null, so no numbers are shown.
 */
export function poolPlanBasis(pool: PlanBasisPool, poolYield: PoolYieldState) {
  const symbols = pairLabelSymbols(pool.pairLabel);
  const shareSymbol = planShareSymbol(symbols);
  // SP-2: counted in the pool's own asset (the stock, or USDC for the stablecoin pool), ≈$ only beside it.
  const assetSymbol = planAssetSymbol(symbols) ?? symbols?.plainSymbol ?? pool.pairLabel;
  const usdPerUnit = typeof pool.usdPerShare === "number" && Number.isFinite(pool.usdPerShare) && pool.usdPerShare > 0 ? pool.usdPerShare : null;
  const unit: AmountUnit = { kind: "asset", symbol: assetSymbol, usdPerUnit };
  const ready = poolYield.status === "ready" ? poolYield : null;
  const poolTvlUsd = pool.tvlUsd !== undefined && pool.tvlUsd !== null && Number.isFinite(pool.tvlUsd) && pool.tvlUsd > 0
    ? pool.tvlUsd : ready?.latestTvlUsd ?? null;
  const notice = ready ? planDataNotice({ sampleDays: ready.best.sampleDays, poolTvlUsd }) : null;
  const best = ready && notice?.kind !== "hide" ? ready.best : null;
  const terms = planPoolTerms({
    descriptor: dexDescriptors.descriptorFor(pool.protocol),
    useDescriptorPlanTerms: uiFor(pool.protocol).useDescriptorPlanTerms,
    listOpenReason: null,
    symbols: symbols ? [symbols.wrappedSymbol, symbols.plainSymbol] : undefined,
  });
  // No exit picker; counted in the asset, the projection keeps the pool tokens (SP-2: no swap back to USDC).
  const exit = terms.exits.includes("tokens") ? "tokens" : terms.exits[0] ?? "usdc";
  return { symbols, shareSymbol, assetSymbol, usdPerUnit, unit, poolTvlUsd, notice, best, terms, exit } as const;
}

export type PoolPlanBasis = ReturnType<typeof poolPlanBasis>;
export type PlanWindow = { aprPct: string; sampleDays: number; windowDays: number; coversAllData?: boolean; poolFeesPerDayUsd?: string };

/**
 * The one projection both surfaces run: `projectPoolPlanInAsset` on the basis's terms, exit and TVL split, with simple
 * (non-compounded) growth, the cards' basis: the deposit earns the same after-cut, fee-capped amount every day.
 */
export function projectOnBasis(basis: PoolPlanBasis, amount: string, window: PlanWindow, days: number) {
  return projectPoolPlanInAsset({
    amount, usdPerUnit: basis.usdPerUnit, days, window, terms: basis.terms, exit: basis.exit, poolTvlUsd: basis.poolTvlUsd,
    growth: "simple",
  });
}

/**
 * "Est. fee APR · 7-day avg": the label beside the projected APR, in the dialog and the homepage estimator. The number
 * beside it is `cappedAprPct` (after the DEX's cut, held to the pool's fees, not compounded).
 */
export const planAprLabel = (window: { windowDays: number; sampleDays: number; coversAllData?: boolean }) => `Est. fee APR · ${aprWindowAvgLabel(window)}`;

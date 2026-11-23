"use client";

import { useMemo, useState } from "react";
import { parsePlanAssetAmount, planAssetAmounts, planAssetPresetLabel } from "@/lib/lp-plan-shares";
import { homepageRows, rwaPairsDefaultOrder } from "@/lib/homepage-pools";
import { poolSupportsCalculator } from "@/lib/unified-pools/plan-support";
import { PROTOCOL_LABELS, type RankGroupLookup, type UnifiedPool } from "@/lib/unified-pools/model";
import type { Apr7dState } from "@/lib/unified-pools/apr7d";
import { cn } from "@/lib/cn";
import { approxUsd, formatInUnit, formatPct } from "./plan/format";
import { usePoolYield } from "./plan/use-pool-yield";
import { planAprLabel, poolPlanBasis, projectOnBasis } from "./plan/pool-plan-basis";

export const ESTIMATOR_TITLE = "Estimated fees collected";
export const ESTIMATOR_RISK_LINE = "Assumes price stays in range. Not a prediction. Fees not guaranteed.";
export const ESTIMATOR_UNAVAILABLE = "Estimate unavailable right now";
/**
 * Wait this long after the pool last changed before reading its fees, so stepping through the list (or the default
 * moving while the ranking settles) asks for the pool that stays, only.
 */
export const ESTIMATOR_SWITCH_DEBOUNCE_MS = 300;

/** The homepage ranking is final once the pools and every listed pool's 7-day APR have loaded. */
const rankingSettled = (pools: readonly UnifiedPool[] | null, apr: Readonly<Record<string, Apr7dState | undefined>>) =>
  Boolean(pools?.length) && !Object.values(apr).some((state) => state?.status === "loading");

/** "SNDKx/SNDK · Raydium 0.25%": the DEX and fee tier say which pool of the pair it is. */
function poolOptionLabel(pool: UnifiedPool): string {
  const tier = typeof pool.feeTierBps === "number" && Number.isFinite(pool.feeTierBps) ? ` ${Number((pool.feeTierBps / 100).toFixed(4))}%` : "";
  return `${pool.pairLabel} · ${PROTOCOL_LABELS[pool.protocol] ?? pool.protocol}${tier}`;
}

const isStockPool = (pool: UnifiedPool) => poolPlanBasis(pool, { status: "idle" }).shareSymbol !== null;

/**
 * Pools the estimator offers, in `/pools`'s default order (one pool per pair), Calculate pools only (same registry
 * capability as the cards), and the one it starts on: the homepage's top-ranked stock pool (never the stablecoin pool).
 */
export function estimatorPools(pools: readonly UnifiedPool[], apr7d: (pool: UnifiedPool) => number | null, group?: RankGroupLookup) {
  const options = rwaPairsDefaultOrder(pools, apr7d, group).filter(poolSupportsCalculator);
  const top = homepageRows(pools, apr7d, group).filter(poolSupportsCalculator);
  const defaultPool = top.find(isStockPool) ?? options.find(isStockPool) ?? options[0] ?? null;
  return { options, defaultPool };
}

/**
 * Homepage fee estimator (SP-2, no wallet): an amount in the pool's own asset and a pool from the list the homepage
 * already loaded, then the estimated fees collected per day and per week in that asset, with ≈$ only when the share price
 * is known. The numbers are the Calculate dialog's own (`usePoolYield` → `poolPlanBasis` → `projectOnBasis`); only the
 * chosen pool's daily fees are read, after a short pause when switching, and remembered for the tab. When they can't be
 * read (error, rate limit, too little data) it says so and shows no number; it never uses another APR instead.
 */
export function HomepageFeeEstimator({ pools, apr, apr7d, group }: {
  pools: readonly UnifiedPool[] | null;
  /** The homepage's 7-day APR states: ranking only (which pool comes first), never a number shown here. */
  apr: Readonly<Record<string, Apr7dState | undefined>>;
  apr7d: (pool: UnifiedPool) => number | null;
  group?: RankGroupLookup;
}) {
  const { options, defaultPool } = useMemo(() => estimatorPools(pools ?? [], apr7d, group), [pools, apr7d, group]);
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const pool = options.find((option) => option.key === chosenKey) ?? defaultPool;
  // Only the selected pool is read; the default waits for the ranking to settle, so no other pool is ever asked for.
  const readKey = chosenKey !== null || rankingSettled(pools, apr) ? pool?.poolAddress : undefined;
  const poolYield = usePoolYield(readKey, { delayMs: ESTIMATOR_SWITCH_DEBOUNCE_MS });
  const [amountText, setAmountText] = useState<string | null>(null);
  if (!pool) return null;

  const basis = poolPlanBasis(pool, poolYield);
  const { unit, best, shareSymbol } = basis;
  const { presets, defaultAmount } = planAssetAmounts(shareSymbol);
  const text = amountText ?? defaultAmount;
  const amount = parsePlanAssetAmount(text);
  const day = best && amount ? projectOnBasis(basis, amount, best, 1).comparison : null;
  const week = best && amount ? projectOnBasis(basis, amount, best, 7).comparison : null;
  const unavailable = poolYield.status === "unavailable" || (poolYield.status === "ready" && !best);
  // usePoolYield is idle until the default pool is settled; show it as loading, like a read in flight.
  const choose = (key: string) => {
    const next = options.find((option) => option.key === key);
    // Another kind of asset (shares vs USDC) starts from its own default amount.
    if (next && isStockPool(next) !== Boolean(shareSymbol)) setAmountText(null);
    setChosenKey(key);
  };

  return <section aria-labelledby="fee-estimator-heading" data-testid="homepage-fee-estimator"
    className="mx-auto mt-6 w-full max-w-xl rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-left sm:p-5">
    <h2 id="fee-estimator-heading" className="text-base font-semibold tracking-[-0.01em] text-cream">{ESTIMATOR_TITLE}</h2>
    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <label className="flex min-w-0 flex-col gap-1 text-[12px] text-smoke">
        Pool
        <select value={pool.key} onChange={(event) => choose(event.target.value)} aria-label="Pool"
          className="h-11 min-w-0 rounded-xl border border-white/15 bg-char px-3 text-base text-cream outline-none focus-visible:shadow-[0_0_0_2px_var(--color-lilac)] sm:text-sm">
          {options.map((option) => <option key={option.key} value={option.key}>{poolOptionLabel(option)}</option>)}
        </select>
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-[12px] text-smoke">
        <span className="flex justify-between gap-2"><span>Amount in {unit.kind === "asset" ? unit.symbol : "USD"}</span>
          {amount && approxUsd(amount, unit) ? <span className="tabular-nums" data-testid="estimator-input-usd">{approxUsd(amount, unit)}</span> : null}</span>
        <input value={text} onChange={(event) => setAmountText(event.target.value)} inputMode="decimal" aria-label={`Amount in ${basis.assetSymbol}`}
          aria-invalid={!amount}
          className={cn("h-11 min-w-0 rounded-xl border border-white/15 bg-char px-3 text-right text-base tabular-nums text-cream outline-none focus-visible:shadow-[0_0_0_2px_var(--color-lilac)] sm:text-sm",
            !amount && "text-coral")} />
      </label>
    </div>
    <div className="mt-2 flex justify-end gap-1.5" data-testid="estimator-presets">
      {presets.map((value) => (
        <button key={value} type="button" onClick={() => setAmountText(value)}
          className="rounded-md bg-white/[0.08] px-2 py-0.5 text-[12px] font-medium text-cream/80 outline-none hover:bg-white/15 focus-visible:shadow-[0_0_0_2px_var(--color-lilac)]">
          {planAssetPresetLabel(value)}
        </button>
      ))}
    </div>
    {unavailable ? <p role="status" className="mt-3 rounded-xl border border-white/10 px-3 py-4 text-center text-sm text-smoke" data-testid="estimator-unavailable">{ESTIMATOR_UNAVAILABLE}</p>
      : !amount ? <p role="status" className="mt-3 text-sm text-smoke">Enter an amount in {basis.assetSymbol} to see the estimate.</p>
      : day && week ? <dl className="mt-3 grid grid-cols-2 gap-2.5" data-testid="estimator-fees">
        {([["Per day", day.feesEarned], ["Per week", week.feesEarned]] as const).map(([label, value]) => (
          <div key={label} className="rounded-xl border border-white/10 px-3 py-2.5">
            <dt className="text-[12px] text-smoke">{label}</dt>
            <dd className="mt-0.5 text-lg font-medium tabular-nums text-mint">{formatInUnit(value, unit)}</dd>
            {approxUsd(value, unit) ? <dd className="text-[11px] tabular-nums text-smoke/80" data-testid="estimator-usd">{approxUsd(value, unit)}</dd> : null}
          </div>
        ))}
      </dl>
      : <p role="status" className="mt-3 text-sm text-smoke" data-testid="estimator-loading">Reading this pool&apos;s past fees…</p>}
    {best && day && !unavailable ? <p className="mt-3 text-[12px] leading-5 text-smoke" data-testid="estimator-basis">
      {`${planAprLabel(best)} ${formatPct(day.cappedAprPct)}`}
    </p> : null}
    <p className="mt-1 text-[12px] leading-5 text-smoke" data-testid="estimator-risk">{ESTIMATOR_RISK_LINE}</p>
  </section>;
}

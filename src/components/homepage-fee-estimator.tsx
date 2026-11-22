"use client";

import { useMemo, useState } from "react";
import { estimatedFeesInAsset } from "@/lib/lp-plan-pool-terms";
import { pairLabelSymbols, parsePlanAssetAmount, planAssetAmounts, planAssetPresetLabel, planAssetSymbol, planShareSymbol } from "@/lib/lp-plan-shares";
import { poolSupportsCalculator } from "@/lib/unified-pools/plan-support";
import { PROTOCOL_LABELS, type UnifiedPool } from "@/lib/unified-pools/model";
import type { Apr7dState } from "@/lib/unified-pools/apr7d";
import { cn } from "@/lib/cn";
import { approxUsd, formatInUnit, formatPct, type AmountUnit } from "./plan/format";

export const ESTIMATOR_TITLE = "Estimated fees collected";
export const ESTIMATOR_RISK_LINE = "Assumes price stays in range. Not a prediction. Fees not guaranteed.";

/** A pool the estimator can offer: the calculator's pools (same registry capability), with its unit and 7-day number. */
type EstimatorPool = {
  pool: UnifiedPool;
  unit: AmountUnit & { kind: "asset" };
  shareSymbol: string | null;
  /** 7-day average fee APR of the best range, percent; null when the pool has no 7-day estimate (not selectable). */
  aprPct: number | null;
  rangeLabel: string | null;
  poolLpFeesPerDayUsd: number | null;
};

function estimatorPools(pools: readonly UnifiedPool[], apr: Readonly<Record<string, Apr7dState | undefined>>,
  apr7d: (pool: UnifiedPool) => number | null): EstimatorPool[] {
  return pools.filter(poolSupportsCalculator).map((pool): EstimatorPool => {
    const symbols = pairLabelSymbols(pool.pairLabel);
    const state = apr[pool.key];
    const ready = state?.status === "ready" ? state : null;
    const aprPct = apr7d(pool);
    return {
      pool,
      shareSymbol: planShareSymbol(symbols),
      unit: { kind: "asset", symbol: planAssetSymbol(symbols) ?? symbols?.plainSymbol ?? pool.pairLabel,
        usdPerUnit: typeof pool.usdPerShare === "number" && pool.usdPerShare > 0 ? pool.usdPerShare : null },
      aprPct: typeof aprPct === "number" && Number.isFinite(aprPct) && aprPct > 0 ? aprPct : null,
      rangeLabel: ready?.rangeLabel ?? null,
      poolLpFeesPerDayUsd: ready?.poolLpFeesPerDayUsd ?? null,
    };
  // Selectable pools first, highest 7-day number first; the rest stay listed but disabled.
  }).sort((a, b) => (b.aprPct ?? -1) - (a.aprPct ?? -1));
}

/** "SNDKx/SNDK · Raydium 0.25%": the same pair can have several pools, so the DEX and fee tier tell them apart. */
function poolOptionLabel(pool: UnifiedPool): string {
  const tier = typeof pool.feeTierBps === "number" && Number.isFinite(pool.feeTierBps) ? ` ${Number((pool.feeTierBps / 100).toFixed(4))}%` : "";
  return `${pool.pairLabel} · ${PROTOCOL_LABELS[pool.protocol] ?? pool.protocol}${tier}`;
}

/**
 * Homepage fee estimator (SP-2, no wallet): an amount in the pool's own asset and a pool from the list the homepage
 * already loaded (no extra request), then the estimated fees collected per day and per week in that asset, with ≈$ as
 * secondary text only when the share price is known. The math is the Calculate dialog's (`estimatedFeesInAsset`).
 */
export function HomepageFeeEstimator({ pools, apr, apr7d, defaultPoolKey }: {
  pools: readonly UnifiedPool[] | null;
  apr: Readonly<Record<string, Apr7dState | undefined>>;
  apr7d: (pool: UnifiedPool) => number | null;
  /** The pool to start on (the top-5 block's first), when it is selectable. */
  defaultPoolKey?: string | null;
}) {
  const options = useMemo(() => estimatorPools(pools ?? [], apr, apr7d), [pools, apr, apr7d]);
  const selectable = options.filter((option) => option.aprPct !== null);
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const fallbackKey = selectable.find((option) => option.pool.key === defaultPoolKey)?.pool.key ?? selectable[0]?.pool.key ?? null;
  const current = selectable.find((option) => option.pool.key === (chosenKey ?? fallbackKey)) ?? null;
  const [amountText, setAmountText] = useState<string | null>(null);
  const { presets, defaultAmount } = planAssetAmounts(current?.shareSymbol ?? null);
  const text = amountText ?? defaultAmount;
  const amount = parsePlanAssetAmount(text);

  if (!selectable.length || !current || current.aprPct === null) return null;
  const aprPct = current.aprPct;
  const at = (days: number) => estimatedFeesInAsset({ amount: amount!, usdPerUnit: current.unit.usdPerUnit, aprPct, days,
    poolLpFeesPerDayUsd: current.poolLpFeesPerDayUsd });
  const fees = amount ? { day: at(1), week: at(7) } : null;
  const unit = current.unit;
  const choose = (key: string) => {
    const next = selectable.find((option) => option.pool.key === key);
    // Another kind of asset (shares vs USDC) starts from its own default amount.
    if (next && Boolean(next.shareSymbol) !== Boolean(current.shareSymbol)) setAmountText(null);
    setChosenKey(key);
  };

  return <section aria-labelledby="fee-estimator-heading" data-testid="homepage-fee-estimator"
    className="mx-auto mt-6 w-full max-w-xl rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-left sm:p-5">
    <h2 id="fee-estimator-heading" className="text-base font-semibold tracking-[-0.01em] text-cream">{ESTIMATOR_TITLE}</h2>
    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <label className="flex min-w-0 flex-col gap-1 text-[12px] text-smoke">
        Pool
        <select value={current.pool.key} onChange={(event) => choose(event.target.value)} aria-label="Pool"
          className="h-11 min-w-0 rounded-xl border border-white/15 bg-char px-3 text-base text-cream outline-none focus-visible:shadow-[0_0_0_2px_var(--color-lilac)] sm:text-sm">
          {options.map((option) => (
            <option key={option.pool.key} value={option.pool.key} disabled={option.aprPct === null}>
              {poolOptionLabel(option.pool)}{option.aprPct === null ? " (no 7-day estimate)" : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-[12px] text-smoke">
        <span className="flex justify-between gap-2"><span>Amount in {unit.symbol}</span>
          {amount && approxUsd(amount, unit) ? <span className="tabular-nums" data-testid="estimator-input-usd">{approxUsd(amount, unit)}</span> : null}</span>
        <input value={text} onChange={(event) => setAmountText(event.target.value)} inputMode="decimal" aria-label={`Amount in ${unit.symbol}`}
          aria-invalid={!amount}
          className={cn("h-11 min-w-0 rounded-xl border border-white/15 bg-char px-3 text-right text-base tabular-nums text-cream outline-none focus-visible:shadow-[0_0_0_2px_var(--color-lilac)] sm:text-sm",
            !amount && "text-coral")} />
      </label>
    </div>
    <div className="mt-2 flex justify-end gap-1.5">
      {presets.map((value) => (
        <button key={value} type="button" onClick={() => setAmountText(value)}
          className="rounded-md bg-white/[0.08] px-2 py-0.5 text-[12px] font-medium text-cream/80 outline-none hover:bg-white/15 focus-visible:shadow-[0_0_0_2px_var(--color-lilac)]">
          {planAssetPresetLabel(value)}
        </button>
      ))}
    </div>
    {fees ? <dl className="mt-3 grid grid-cols-2 gap-2.5" data-testid="estimator-fees">
      {([["Per day", fees.day], ["Per week", fees.week]] as const).map(([label, value]) => (
        <div key={label} className="rounded-xl border border-white/10 px-3 py-2.5">
          <dt className="text-[12px] text-smoke">{label}</dt>
          <dd className="mt-0.5 text-lg font-medium tabular-nums text-mint">{formatInUnit(value, unit)}</dd>
          {approxUsd(value, unit) ? <dd className="text-[11px] tabular-nums text-smoke/80" data-testid="estimator-usd">{approxUsd(value, unit)}</dd> : null}
        </div>
      ))}
    </dl> : <p role="status" className="mt-3 text-sm text-smoke">Enter an amount in {unit.symbol} to see the estimate.</p>}
    <p className="mt-3 text-[12px] leading-5 text-smoke" data-testid="estimator-basis">
      {`${current.rangeLabel ? `${current.rangeLabel} range · ` : ""}7-day average fee APR ${formatPct(String(current.aprPct))}`}
    </p>
    <p className="mt-1 text-[12px] leading-5 text-smoke" data-testid="estimator-risk">{ESTIMATOR_RISK_LINE}</p>
  </section>;
}

"use client";

import { formatPlanPoolOption, type PlanPairOption } from "@/lib/lp-plan-selection";

const shortId = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;

export function PoolSelect({
  poolId,
  pair,
  options,
  loading,
  onChange,
}: {
  poolId?: string;
  pair?: string;
  options: readonly PlanPairOption[];
  loading: boolean;
  onChange: (poolId: string) => void;
}) {
  const currentLabel = pair ?? (poolId ? shortId(poolId) : "Choose a pool");
  const known = options.some((row) => row.poolAddress === poolId);
  return (
    <label className="inline-flex min-w-0 max-w-full items-center gap-2 font-data text-[10px] uppercase tracking-[0.14em] text-ink/60">
      Pool
      <select
        aria-label="Pool"
        value={poolId ?? ""}
        disabled={loading && options.length === 0 && !poolId}
        onChange={(event) => onChange(event.target.value)}
        className="normal-case min-w-0 max-w-[22rem] truncate rounded-full border border-ink/20 bg-transparent px-2.5 py-1 font-data text-[10px] tracking-[0.08em] text-ink outline-none focus-visible:border-ink"
      >
        {!poolId ? <option value="">Choose a pool</option> : null}
        {poolId && !known ? <option value={poolId}>{currentLabel}</option> : null}
        {options.map((row) => (
          <option key={row.poolAddress} value={row.poolAddress}>
            {formatPlanPoolOption(row)}
          </option>
        ))}
      </select>
    </label>
  );
}

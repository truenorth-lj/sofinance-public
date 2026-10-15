"use client";
import "@/lib/engine-host";

import { formatAmountDisplay } from "@sofinance/engine/amount";
import { TokenIcon } from "./token-icon";

const usd = (raw: string | null | undefined, decimals: number, priceUsd: number | null) => {
  if (priceUsd === null || raw === null || raw === undefined || !/^\d+$/.test(raw)) return "—";
  const value = (Number(raw) / 10 ** decimals) * priceUsd;
  return Number.isFinite(value) ? value.toLocaleString("en-US", { style: "currency", currency: "USD" }) : "—";
};

/**
 * One token of an LP position: the amount sitting in liquidity and, on its own labelled line, the unclaimed (not yet
 * collected) trading fees. Both are atomic strings so amounts are never routed through floating point; the sum of the two
 * lines is the token's share of "Current position value".
 */
export function PositionAssetRow({ symbol, icon, decimals, liquidityRaw, unclaimedFeesRaw, priceUsd }: {
  symbol: string;
  icon: string | null;
  decimals: number;
  liquidityRaw: string;
  /** null/undefined while the fee read is loading or unavailable (shown as a dash, never as zero). */
  unclaimedFeesRaw?: string | null;
  priceUsd: number | null;
}) {
  return (
    <div className="flex items-center gap-3 py-4 first:pt-0 last:pb-0">
      <TokenIcon symbol={symbol} icon={icon} />
      <dl className="min-w-0 flex-1 space-y-1">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-[11px] text-smoke">Liquidity</dt>
          <dd className="flex min-w-0 flex-1 flex-wrap items-baseline justify-end gap-x-2 text-right">
            <span className="font-display text-sm font-semibold tabular-nums text-cream sm:text-base">{formatAmountDisplay(liquidityRaw, decimals)}</span>
            <span className="font-display text-sm font-medium text-smoke">{symbol}</span>
            <span className="w-24 shrink-0 font-display text-sm font-semibold tabular-nums text-cream sm:text-base" aria-label={`${symbol} liquidity value in USD`}>{usd(liquidityRaw, decimals, priceUsd)}</span>
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 text-[11px] tabular-nums text-smoke">
          <dt>Unclaimed fees</dt>
          <dd className="flex min-w-0 flex-1 flex-wrap items-baseline justify-end gap-x-2 text-right">
            <span>{formatAmountDisplay(unclaimedFeesRaw, decimals)} {symbol}</span>
            <span className="w-24 shrink-0" aria-label={`${symbol} unclaimed fees value in USD`}>{usd(unclaimedFeesRaw, decimals, priceUsd)}</span>
          </dd>
        </div>
      </dl>
    </div>
  );
}

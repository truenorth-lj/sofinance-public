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
  /** null while the amounts are loading or could not be read (shown as a dash, never as zero). */
  liquidityRaw: string | null;
  /** null/undefined while the fee read is loading or unavailable (shown as a dash, never as zero). */
  unclaimedFeesRaw?: string | null;
  priceUsd: number | null;
}) {
  // One grid for both lines: label | amount + symbol | USD. The columns are shared by both lines (and have the same
  // template for every token), so the amounts and the USD values line up in one column each, at 375 px too; nothing
  // wraps a value onto its own line, and each cell shows exactly one value (or one dash).
  return (
    <div className="flex items-center gap-3 py-4 first:pt-0 last:pb-0">
      <TokenIcon symbol={symbol} icon={icon} />
      <dl className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)_4.75rem] items-baseline gap-x-2 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)_6rem] sm:gap-x-3">
        <dt className="text-[11px] text-smoke">Liquidity</dt>
        <dd className="min-w-0 break-words text-right">
          <span className="font-display text-sm font-semibold tabular-nums text-cream sm:text-base">{formatAmountDisplay(liquidityRaw, decimals)}</span>{" "}
          <span className="font-display text-sm font-medium text-smoke">{symbol}</span>
        </dd>
        <dd className="text-right font-display text-sm font-semibold tabular-nums text-cream sm:text-base" aria-label={`${symbol} liquidity value in USD`}>{usd(liquidityRaw, decimals, priceUsd)}</dd>
        <dt className="text-[11px] text-smoke">Unclaimed fees</dt>
        <dd className="min-w-0 break-words text-right text-[11px] tabular-nums text-smoke">{formatAmountDisplay(unclaimedFeesRaw, decimals)} {symbol}</dd>
        <dd className="text-right text-[11px] tabular-nums text-smoke" aria-label={`${symbol} unclaimed fees value in USD`}>{usd(unclaimedFeesRaw, decimals, priceUsd)}</dd>
      </dl>
    </div>
  );
}

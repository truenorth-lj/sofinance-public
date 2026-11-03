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
  // One grid for both lines. The layout follows the row's own width (a container query), not the screen, because the
  // same row sits in a full-width phone card and in the narrow My positions column on desktop:
  // - narrow (below 28rem): each label on its own line, then amount + symbol (left) and USD (right) on the next one, so
  //   the amount gets most of the width and never wraps a character at a time;
  // - wide: label | amount + symbol | USD, the columns shared by both lines so amounts and USD values line up.
  // Each cell shows exactly one value (or one dash).
  return (
    <div className="@container flex items-center gap-3 py-4 first:pt-0 last:pb-0">
      <TokenIcon symbol={symbol} icon={icon} />
      <dl className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 @md:grid-cols-[auto_minmax(0,1fr)_6rem] @md:gap-y-1">
        <dt className="col-span-2 text-[11px] text-smoke @md:col-span-1">Liquidity</dt>
        <dd className="min-w-0 break-words @md:text-right">
          <span className="font-display text-base font-semibold tabular-nums text-cream">{formatAmountDisplay(liquidityRaw, decimals)}</span>{" "}
          <span className="font-display text-sm font-medium text-smoke">{symbol}</span>
        </dd>
        <dd className="whitespace-nowrap text-right font-display text-sm font-semibold tabular-nums text-cream @md:text-base" aria-label={`${symbol} liquidity value in USD`}>{usd(liquidityRaw, decimals, priceUsd)}</dd>
        <dt className="col-span-2 mt-2 text-[11px] text-smoke @md:col-span-1 @md:mt-0">Unclaimed fees</dt>
        <dd className="min-w-0 break-words text-[11px] tabular-nums text-smoke @md:text-right">{formatAmountDisplay(unclaimedFeesRaw, decimals)} {symbol}</dd>
        <dd className="whitespace-nowrap text-right text-[11px] tabular-nums text-smoke" aria-label={`${symbol} unclaimed fees value in USD`}>{usd(unclaimedFeesRaw, decimals, priceUsd)}</dd>
      </dl>
    </div>
  );
}

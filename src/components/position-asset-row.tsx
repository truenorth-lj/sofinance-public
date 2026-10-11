"use client";

import { TokenIcon } from "./token-icon";

export function PositionAssetRow({ symbol, icon, amount, fees, priceUsd }: {
  symbol: string;
  icon: string | null;
  amount: number;
  fees?: number;
  priceUsd: number | null;
}) {
  const valueUsd = priceUsd === null ? null : amount * priceUsd;
  return (
    <div className="flex items-center gap-3 py-4 first:pt-0 last:pb-0">
      <TokenIcon symbol={symbol} icon={icon} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-display text-sm font-semibold tabular-nums text-cream sm:text-base">{Number.isFinite(amount) ? amount.toPrecision(8) : "—"}</span>
          <span className="font-display text-sm font-medium text-smoke">{symbol}</span>
        </div>
        {fees !== undefined && <p className="mt-1 text-[11px] tabular-nums text-smoke">Fees earned {fees.toPrecision(6)} {symbol}</p>}
      </div>
      <span className="shrink-0 text-right font-display text-sm font-semibold tabular-nums text-cream sm:text-base" aria-label={`${symbol} value in USD`}>
        {valueUsd !== null && Number.isFinite(valueUsd) ? valueUsd.toLocaleString("en-US", { style: "currency", currency: "USD" }) : "—"}
      </span>
    </div>
  );
}


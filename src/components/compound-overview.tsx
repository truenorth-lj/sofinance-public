"use client";
import "@/lib/engine-host";

import { formatAmount } from "@sofinance/engine/amount";
import { formatUsdcValue, tokenUsdValue } from "@/lib/compound-cost";
import type { CompoundPositionState, CompoundSummary } from "@sofinance/engine/compound-types";

const amount = (raw: string, decimals: number) => formatAmount(raw, decimals, Math.min(decimals, 9));

export function CompoundOverview({ state, summary, tokenLabel, prices }: {
  state: CompoundPositionState; summary: CompoundSummary | null; tokenLabel: (mint: string) => string;
  prices: { rate: number | null; usdcUsd: number | null };
}) {
  const displayedState = summary?.state ?? state;
  const harvest = summary?.simulatedHarvest ?? state.fees;
  const a = tokenLabel(displayedState.mintA);
  const b = tokenLabel(displayedState.mintB);
  const pairAmount = (values: { a: string; b: string }) => `${amount(values.a, displayedState.decimalsA)} ${a} + ${amount(values.b, displayedState.decimalsB)} ${b}`;
  const usdc = (raw: string, decimals: number, price: number | null | undefined) => {
    const usd = tokenUsdValue(raw, decimals, price);
    return usd === 0 ? 0 : usd !== null && prices.usdcUsd !== null ? usd / prices.usdcUsd : null;
  };
  const harvestA = usdc(harvest.a, displayedState.decimalsA, displayedState.pricing?.priceUsdA);
  const harvestB = usdc(harvest.b, displayedState.decimalsB, displayedState.pricing?.priceUsdB);
  const totalUsdc = harvestA !== null && harvestB !== null ? harvestA + harvestB : null;
  const swap = summary?.swaps?.[0];
  const protocolFee = summary && BigInt(summary.feeAmount ?? "0") > 0n ? summary : null;
  return <section aria-label="Harvest" className="mt-5 min-w-0 rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
    <h3 className="text-sm text-smoke">Harvest</h3>
    <p className="mt-3 break-words text-lg font-semibold tabular-nums text-cream">{totalUsdc !== null ? `≈ ${formatUsdcValue(totalUsdc)}` : "USDC estimate unavailable"}</p>
    <p className="mt-1 break-words text-xs tabular-nums text-smoke">{pairAmount(harvest)}</p>
    {protocolFee && swap && <p className="mt-3 break-words text-xs tabular-nums text-smoke">Protocol fee ({(protocolFee.feeBps / 100).toFixed(2)}%): {amount(protocolFee.feeAmount, swap.inputDecimals)} {tokenLabel(swap.inputMint)}</p>}
  </section>;
}

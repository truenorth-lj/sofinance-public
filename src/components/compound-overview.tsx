"use client";
import "@/lib/engine-host";

import { formatAmount } from "@sofinance/engine/amount";
import type { CompoundSummary } from "@sofinance/engine/compound-types";

const amount = (raw: string, decimals: number) => formatAmount(raw, decimals, Math.min(decimals, 9));

/**
 * The compound's protocol fee, once a simulated compound swaps part of the fees (stated before signing). The "Fees to
 * compound" card (≈ USDC and per-token amounts) was removed (LJ 11/14): the position's row already shows its fees.
 */
export function CompoundProtocolFee({ summary, tokenLabel }: { summary: CompoundSummary | null; tokenLabel: (mint: string) => string }) {
  const swap = summary?.swaps?.[0];
  const protocolFee = summary && BigInt(summary.feeAmount ?? "0") > 0n ? summary : null;
  if (!protocolFee || !swap) return null;
  return <p data-testid="compound-protocol-fee" className="mt-4 break-words text-xs tabular-nums text-smoke">Protocol fee ({(protocolFee.feeBps / 100).toFixed(2)}%): {amount(protocolFee.feeAmount, swap.inputDecimals)} {tokenLabel(swap.inputMint)}</p>;
}

import type { OpenPositionSummary } from "@sofinance/engine/open-types";
import { notionalUsdFromQuote } from "./notional";
import { sanitizeAddress, sanitizeSourceRef, sanitizeSymbol, sanitizeTxSignature } from "./sanitize";
import type { PositionOpenRow } from "./types";

export function positionOpenRowFromSummary(input: {
  signature: string;
  wallet: string;
  summary: OpenPositionSummary;
  sourceRef?: unknown;
}): PositionOpenRow | null {
  const txSignature = sanitizeTxSignature(input.signature);
  const wallet = sanitizeAddress(input.wallet) ?? sanitizeAddress(input.summary.wallet);
  const poolAddress = sanitizeAddress(input.summary.poolId);
  if (!txSignature || !wallet || !poolAddress) return null;
  const quote = input.summary.quote as { symbolA?: unknown; symbolB?: unknown; inputMint?: string; inputDecimals?: number; requested?: string };
  return {
    txSignature,
    wallet,
    poolAddress,
    symbolA: sanitizeSymbol(quote?.symbolA),
    symbolB: sanitizeSymbol(quote?.symbolB),
    notionalUsd: notionalUsdFromQuote(quote),
    sourceRef: sanitizeSourceRef(input.sourceRef),
  };
}

import { matchWrapPairShape } from "@/lib/rwa-pairing";
import type { UnifiedPool } from "@/lib/unified-pools/model";

type PairLabelSource = Pick<UnifiedPool, "pairLabel">;

function joinPairParts(parts: string[], sep: string): string {
  return parts.map((part) => part.trim()).filter(Boolean).join(sep);
}

/**
 * Canonical App pair name, re-joined with `sep`.
 * `pool.pairLabel` is already in display order: Solana is wrapped/plain, RHC is Robinhood-first.
 */
export function poolPairLabel(pool: PairLabelSource, sep = "/"): string {
  return joinPairParts(pool.pairLabel.split("/"), sep);
}

/**
 * Same canonical order as App cards when only two symbols are available
 * (wrapped/plain when the symbols form a wrap pair; otherwise the given order).
 */
export function poolPairLabelFromSymbols(symbolA: string, symbolB: string, sep = "/"): string {
  const wrap = matchWrapPairShape(symbolA, symbolB);
  const parts = wrap.matched ? [wrap.wrappedSymbol, wrap.plainSymbol] : [symbolA, symbolB];
  return joinPairParts(parts, sep);
}

/** Fee tier in the App card style, e.g. "5 bps". */
export function poolFeeTierLabel(bps: number): string;
export function poolFeeTierLabel(bps: number | null | undefined): string | null;
export function poolFeeTierLabel(bps: number | null | undefined): string | null {
  if (bps === null || bps === undefined || !Number.isFinite(bps) || bps < 0) return null;
  return `${Math.round(bps)} bps`;
}

/** Base58 Solana address, same shape the pool-daily-apr route accepts. */
export const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Owner’s preferred two-sided RWA pool when the Plan page has no `?pool=`. */
export const DEFAULT_PLAN_POOL_ID = "DUzBLHZ5RZdftPuWVijsvjupndogRM1adGJpsR7YTJro";
export const DEFAULT_PLAN_PAIR = "SPCXx/SPCX";

export function parseSolanaAddress(raw: string | null | undefined): string | undefined {
  const value = raw?.trim() ?? "";
  return SOLANA_ADDRESS.test(value) ? value : undefined;
}

/** Display label such as `SPCXx/SPCX`. Rejects empty, oversized, or address-shaped values. */
export function parsePairLabel(raw: string | null | undefined): string | undefined {
  const value = raw?.trim() ?? "";
  if (!value || value.length > 32 || SOLANA_ADDRESS.test(value)) return undefined;
  return value;
}

export function pairLabelFromSymbols(wrapped: string, plain: string): string {
  return `${wrapped}/${plain}`;
}

export type PlanPairOption = {
  poolAddress: string;
  wrappedSymbol: string;
  plainSymbol: string;
};

/**
 * URL `?pool=` / `?pair=` win when present. A pair-only link is resolved from
 * the cached RWA list. Otherwise the Plan page opens on the SPCXx/SPCX pool.
 */
export function resolvePlanSelection(input: {
  poolId?: string;
  pair?: string;
  pairs?: readonly PlanPairOption[];
}): { poolId?: string; pair?: string } {
  const pairs = input.pairs ?? [];
  if (input.poolId) {
    const found = pairs.find((row) => row.poolAddress === input.poolId);
    return {
      poolId: input.poolId,
      pair: input.pair ?? (found ? pairLabelFromSymbols(found.wrappedSymbol, found.plainSymbol) : undefined),
    };
  }
  if (input.pair) {
    const found = pairs.find((row) => pairLabelFromSymbols(row.wrappedSymbol, row.plainSymbol) === input.pair);
    return found ? { poolId: found.poolAddress, pair: input.pair } : { pair: input.pair };
  }
  return { poolId: DEFAULT_PLAN_POOL_ID, pair: DEFAULT_PLAN_PAIR };
}

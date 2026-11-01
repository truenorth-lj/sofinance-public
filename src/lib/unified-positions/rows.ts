import type { ChainId, PositionSourceId, RangeStatus, UnifiedPosition } from "./model";

export const CHAIN_LABELS: Readonly<Record<ChainId, string>> = Object.freeze({ solana: "Solana", "robinhood-chain": "Robinhood Chain" });
const CHAIN_ORDER: readonly ChainId[] = ["solana", "robinhood-chain"];
const STATUS_ORDER: Readonly<Record<RangeStatus, number>> = { in: 0, below: 1, above: 1, unknown: 2 };

export const isClosed = (position: Pick<UnifiedPosition, "liquidity">) => position.liquidity === "0";

/**
 * Sort order inside one chain group (PM decisions): open before closed (liquidity 0, labelled "Closed", never hidden), in range
 * first, then USD value high → low (unpriced last), then source, pool and id. Not used by `/app` yet (PR-A keeps the scan order).
 */
export function comparePositions(a: UnifiedPosition, b: UnifiedPosition): number {
  return Number(isClosed(a)) - Number(isClosed(b))
    || STATUS_ORDER[a.rangeStatus] - STATUS_ORDER[b.rangeStatus]
    || (b.valueUsd ?? -Infinity) - (a.valueUsd ?? -Infinity)
    || a.source.localeCompare(b.source)
    || a.poolId.localeCompare(b.poolId)
    || a.nativeId.localeCompare(b.nativeId);
}

export type PositionGroup = { chain: ChainId; label: string; positions: UnifiedPosition[]; showSourceName: boolean };

/** Group into dropdown optgroups (Solana, then Robinhood Chain); empty chains are dropped. */
export function groupPositions(positions: UnifiedPosition[], enabledSources: Partial<Record<ChainId, readonly PositionSourceId[]>> = {}): PositionGroup[] {
  return CHAIN_ORDER.flatMap((chain) => {
    const items = positions.filter((item) => item.chain === chain).sort(comparePositions);
    if (!items.length) return [];
    const sources = enabledSources[chain] ?? [...new Set(items.map((item) => item.source))];
    return [{ chain, label: CHAIN_LABELS[chain], positions: items, showSourceName: sources.length >= 2 }];
  });
}

import type { ChainId, PositionSource, PositionSourceId, RangeStatus, UnifiedPosition } from "./model";

export const CHAIN_LABELS: Readonly<Record<ChainId, string>> = Object.freeze({ solana: "Solana", "robinhood-chain": "Robinhood Chain" });
const CHAIN_ORDER: readonly ChainId[] = ["solana", "robinhood-chain"];
const STATUS_ORDER: Readonly<Record<RangeStatus, number>> = { in: 0, below: 1, above: 1, unknown: 2 };

export const CLOSED_LABEL = "Closed";
export const isClosed = (position: Pick<UnifiedPosition, "liquidity">) => position.liquidity === "0";

/**
 * Sort order inside one chain group (PM decisions): open before closed (liquidity 0, labelled "Closed", never hidden), in range
 * first, then USD value high → low (unpriced last), then source, pool and id. Equal keys keep the source's order (stable sort).
 */
export function comparePositions(a: UnifiedPosition, b: UnifiedPosition): number {
  return Number(isClosed(a)) - Number(isClosed(b))
    || STATUS_ORDER[a.rangeStatus] - STATUS_ORDER[b.rangeStatus]
    || (b.valueUsd ?? -Infinity) - (a.valueUsd ?? -Infinity)
    || a.source.localeCompare(b.source)
    || a.poolId.localeCompare(b.poolId)
    || a.nativeId.localeCompare(b.nativeId);
}

/** RHC rows have no pool price or value: keep the source's order (wallet holdings newest first) apart from Closed last. */
function compareInChain(chain: ChainId) {
  return chain === "solana" ? comparePositions : (a: UnifiedPosition, b: UnifiedPosition) => Number(isClosed(a)) - Number(isClosed(b));
}

export type PositionGroup = { chain: ChainId; label: string; positions: UnifiedPosition[]; showSourceName: boolean };

/**
 * Dropdown optgroups: Solana, then Robinhood Chain. A chain with no positions is dropped unless listed in `keepEmpty` (its
 * group then shows a disabled "No positions found" row). The source name shows only when the chain has 2+ enabled sources.
 */
/** Empty-state option under the Solana group when no Solana wallet is connected (the prompt stays out of other chains' panels). */
export const SOLANA_CONNECT_EMPTY_OPTION = "Connect a Solana wallet to see Solana positions";

export function groupPositions(positions: UnifiedPosition[], enabledSources: Partial<Record<ChainId, readonly PositionSourceId[]>> = {},
  keepEmpty: readonly ChainId[] = []): PositionGroup[] {
  return CHAIN_ORDER.flatMap((chain) => {
    const items = positions.filter((item) => item.chain === chain).sort(compareInChain(chain));
    if (!items.length && !keepEmpty.includes(chain)) return [];
    const sources = enabledSources[chain] ?? [...new Set(items.map((item) => item.source))];
    return [{ chain, label: CHAIN_LABELS[chain], positions: items, showSourceName: sources.length >= 2 }];
  });
}

/** `Raydium CLMM · SPCXx/SPCX · … · Closed`: source name only when asked, "Closed" for liquidity 0. */
export function positionOptionLabel<N>(source: Pick<PositionSource<N>, "displayName" | "label">, position: UnifiedPosition<N>,
  options: { showSourceName?: boolean; metadata?: Parameters<PositionSource<N>["label"]>[1] } = {}): string {
  const parts = [source.label(position, options.metadata)];
  if (options.showSourceName) parts.unshift(source.displayName);
  if (isClosed(position)) parts.push(CLOSED_LABEL);
  return parts.join(" · ");
}

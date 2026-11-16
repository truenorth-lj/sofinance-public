import type { WalletDiscovery, WalletPosition } from "@sofinance/engine/wallet-discovery";
import { dexDescriptors } from "@/lib/dex/client";
import { formatPositionLabel } from "@/lib/position-label";
import { positionKey, type PositionSource, type RangeStatus, type UnifiedPosition } from "../model";

// The registered native capability record is shared with API/MCP preparation.
const descriptor = dexDescriptors.descriptorFor("raydium-clmm")!;
const STATUS: Readonly<Record<WalletPosition["rangeSide"], RangeStatus>> = { inside: "in", below: "below", above: "above" };

export function raydiumUnifiedPosition(position: WalletPosition): UnifiedPosition<WalletPosition> {
  return {
    key: positionKey(descriptor.id, position.positionMint),
    source: descriptor.id,
    chain: descriptor.chain,
    nativeId: position.positionMint,
    poolId: position.poolId,
    tokenA: { id: position.mintA, symbol: position.symbolA, decimals: position.decimalsA },
    tokenB: { id: position.mintB, symbol: position.symbolB, decimals: position.decimalsB },
    range: { mode: "tick", tickLower: position.tickLower, tickUpper: position.tickUpper, currentTick: position.tickCurrent },
    rangeStatus: STATUS[position.rangeSide] ?? "unknown",
    liquidity: position.liquidity,
    native: position,
  };
}

/** Raydium CLMM on Solana: every `/app` tool works today (compound, Performance, Add, partial + full Withdraw, USDC exit estimate). */
export const raydiumPositionSource: PositionSource<WalletPosition, Pick<WalletDiscovery, "positions">> = Object.freeze({
  id: descriptor.id,
  chain: descriptor.chain,
  displayName: descriptor.displayName,
  capabilities: descriptor.nativeCapabilities!.positions,
  fromDiscovery: (discovery) => (discovery?.positions ?? []).map(raydiumUnifiedPosition),
  label: (position, metadata) => formatPositionLabel(position.native, metadata),
});

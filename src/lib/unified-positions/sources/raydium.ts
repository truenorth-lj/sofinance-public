import type { WalletDiscovery, WalletPosition } from "@sofinance/engine/wallet-discovery";
import { formatPositionLabel } from "@/lib/position-label";
import { positionKey, SUPPORTED, type PositionSource, type RangeStatus, type UnifiedPosition } from "../model";

const STATUS: Readonly<Record<WalletPosition["rangeSide"], RangeStatus>> = { inside: "in", below: "below", above: "above" };

export function raydiumUnifiedPosition(position: WalletPosition): UnifiedPosition<WalletPosition> {
  return {
    key: positionKey("raydium-clmm", position.positionMint),
    source: "raydium-clmm",
    chain: "solana",
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
  id: "raydium-clmm",
  chain: "solana",
  displayName: "Raydium CLMM",
  capabilities: Object.freeze({
    compound: SUPPORTED,
    performance: SUPPORTED,
    deposit: SUPPORTED,
    withdraw: Object.freeze({ supported: true, partial: true }),
    exitPreview: Object.freeze({ supported: true, output: "usdc+sol" }),
    rangeDisplay: "price",
    manualAdd: false,
    signer: "solana-wallet",
  }),
  fromDiscovery: (discovery) => (discovery?.positions ?? []).map(raydiumUnifiedPosition),
  label: (position, metadata) => formatPositionLabel(position.native, metadata),
});

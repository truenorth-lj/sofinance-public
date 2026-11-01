import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import type { PositionLookup, RhcPositionView } from "@sofinance/engine/protocols/uniswap-v4/exit-flow";
import type { ScannedPosition } from "@sofinance/engine/protocols/uniswap-v4/position-scan";
import { rhcPairLabel } from "@/lib/unified-pools/rows";
import { NOT_AVAILABLE_MESSAGE, positionKey, unsupported, type PositionSource, type SourceCapabilities, type UnifiedPosition } from "../model";
import { formatTickPriceRange, type PriceRange } from "../range";

/** One Robinhood Chain row: a wallet holding from the scan, or an NFT id opened in this browser / added by hand. */
export type RhcNative = { lookup: PositionLookup; held: ScannedPosition | null; priceRange: PriceRange | null };
export type RhcDiscovery = { scanned: readonly ScannedPosition[]; lookups: readonly PositionLookup[] };

const specFor = (poolId: string | null | undefined) =>
  poolId ? UNIV4_RHC_ALLOWLISTED_POOLS.find((spec) => spec.poolId.toLowerCase() === poolId.toLowerCase()) ?? null : null;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Why this position cannot be closed here (same wording as the pools-page positions panel), or null. */
export function rhcCloseBlockReason(native: RhcNative): string | null {
  const p = native.lookup.position;
  if (!p) return native.lookup.error === "rpc" ? "Could not read this position right now." : "Closed (or never existed).";
  if (!p.ownedByUser) return `Owned by another wallet (${short(p.owner)}).`;
  if (!specFor(p.poolId)) return native.held?.stablePair ? "StablePair pool that SoFinance does not list yet: view only."
    : native.held ? "Another Uniswap v4 pool, not supported by SoFinance: view only." : "Not in a pool SoFinance supports.";
  return null;
}

function priceRangeOf(p: RhcPositionView | null, stablePair: boolean): PriceRange | null {
  const spec = specFor(p?.poolId);
  if (!p || !spec) return null;
  return formatTickPriceRange({ tickLower: p.tickLower, tickUpper: p.tickUpper, token0: spec.currency0, token1: spec.currency1, stablePair });
}

export function rhcUnifiedPosition(lookup: PositionLookup, held: ScannedPosition | null): UnifiedPosition<RhcNative> {
  const p = lookup.position;
  const spec = specFor(p?.poolId);
  // Every allowlisted pool is a StablePair hook pool.
  const priceRange = priceRangeOf(p, Boolean(spec) || Boolean(held?.stablePair));
  return {
    key: positionKey("rhc-uniswap-v4", lookup.tokenId),
    source: "rhc-uniswap-v4",
    chain: "robinhood-chain",
    nativeId: lookup.tokenId,
    poolId: p?.poolId ?? "",
    tokenA: spec ? { id: spec.currency0.address, symbol: spec.currency0.symbol, decimals: spec.currency0.decimals } : { id: "", symbol: null, decimals: 18 },
    tokenB: spec ? { id: spec.currency1.address, symbol: spec.currency1.symbol, decimals: spec.currency1.decimals } : { id: "", symbol: null, decimals: 18 },
    range: priceRange
      ? { mode: "price", lower: Number(priceRange.lower), upper: Number(priceRange.upper), current: null }
      : { mode: "tick", tickLower: p?.tickLower ?? 0, tickUpper: p?.tickUpper ?? 0, currentTick: null },
    // The position read carries no pool price, so in/out of range is not known here.
    rangeStatus: "unknown",
    liquidity: p ? p.liquidity : "0",
    native: { lookup, held, priceRange },
  };
}

const CAPABILITIES: SourceCapabilities = Object.freeze({
  compound: unsupported(NOT_AVAILABLE_MESSAGE),
  performance: unsupported(NOT_AVAILABLE_MESSAGE),
  deposit: unsupported(NOT_AVAILABLE_MESSAGE),
  withdraw: Object.freeze({ supported: true, partial: false }),
  withdrawOutputs: Object.freeze(["pool-tokens"] as const),
  exitPreview: Object.freeze({ supported: true, output: "pool-tokens" }),
  rangeDisplay: "price",
  manualAdd: true,
  signer: "evm-wallet",
});

/** Uniswap v4 on Robinhood Chain: list (scan + local ids) and full Close only; the other tools are not built yet. */
export const rhcPositionSource: PositionSource<RhcNative, RhcDiscovery> = Object.freeze({
  id: "rhc-uniswap-v4",
  chain: "robinhood-chain",
  displayName: "Uniswap v4",
  capabilities: CAPABILITIES,
  /** Wallet holdings first (scan order, newest NFT first), then local ids the scan did not find (deduped by NFT id). */
  fromDiscovery: (discovery) => {
    const scanned = discovery?.scanned ?? [];
    const seen = new Set(scanned.map((s) => s.tokenId));
    return [...scanned.map((s) => rhcUnifiedPosition(s, s)), ...(discovery?.lookups ?? []).filter((l) => !seen.has(l.tokenId)).map((l) => rhcUnifiedPosition(l, null))];
  },
  label: (position) => {
    const { lookup, priceRange } = position.native;
    const pair = lookup.position?.poolId ? rhcPairLabel(lookup.position.poolId, " / ") : null;
    return [`#${lookup.tokenId}`, pair, priceRange ? `range ${priceRange.text}` : lookup.position ? `ticks ${lookup.position.tickLower} to ${lookup.position.tickUpper}` : null]
      .filter(Boolean).join(" · ");
  },
  positionCapabilities: (position) => {
    const reason = rhcCloseBlockReason(position.native);
    return reason ? { withdraw: { supported: false, reason }, exitPreview: unsupported(reason) } : {};
  },
});

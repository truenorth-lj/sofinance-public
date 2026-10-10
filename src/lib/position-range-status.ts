import { uiPriceBPerAFromTick } from "./position-performance-math";

export const DEFAULT_NEAR_EDGE_FRACTION = 0.1;

export type RangeSide = "below" | "inside" | "above";

export type PositionRangeStatus = {
  rangeSide: RangeSide;
  inRange: boolean;
  nearEdge: boolean;
  edge: "lower" | "upper" | null;
  priceBPerA: number;
  priceLower: number;
  priceUpper: number;
  distanceToLowerPct: number | null;
  distanceToUpperPct: number | null;
  priceSource: "solami-blur" | "on-chain" | "unknown";
};

/**
 * Map a Blur pool `price` onto Raydium mintA/mintB orientation (B per 1 A).
 * Blur fields are `mint` / `quote_mint` / `price` (quote per base).
 */
export function blurPriceToBPerA(
  price: number | null,
  blurMint: string | null,
  blurQuoteMint: string | null,
  mintA: string,
  mintB: string,
): number | null {
  if (price === null || !(price > 0) || !Number.isFinite(price)) return null;
  if (blurMint === mintA && blurQuoteMint === mintB) return price;
  if (blurMint === mintB && blurQuoteMint === mintA) return 1 / price;
  // Orientation unverified against this pair — use the raw price (documented assumption).
  return price;
}

export function rangeStatusFromPrice(input: {
  priceBPerA: number;
  tickLower: number;
  tickUpper: number;
  decimalsA: number;
  decimalsB: number;
  nearEdgeFraction?: number;
  priceSource?: PositionRangeStatus["priceSource"];
}): PositionRangeStatus {
  if (!Number.isFinite(input.priceBPerA) || input.priceBPerA <= 0) {
    throw new Error("Price must be a positive B-per-A value");
  }
  const priceLower = uiPriceBPerAFromTick(input.tickLower, input.decimalsA, input.decimalsB);
  const priceUpper = uiPriceBPerAFromTick(input.tickUpper, input.decimalsA, input.decimalsB);
  if (!(priceUpper > priceLower)) throw new Error("Invalid position ticks range");

  const price = input.priceBPerA;
  let rangeSide: RangeSide;
  if (price <= priceLower) rangeSide = "below";
  else if (price >= priceUpper) rangeSide = "above";
  else rangeSide = "inside";

  const width = priceUpper - priceLower;
  const band = width * (input.nearEdgeFraction ?? DEFAULT_NEAR_EDGE_FRACTION);
  const distLower = price - priceLower;
  const distUpper = priceUpper - price;
  let nearEdge = false;
  let edge: "lower" | "upper" | null = null;
  if (rangeSide === "inside" && band > 0) {
    if (distLower <= band || distUpper <= band) {
      nearEdge = true;
      edge = distLower <= distUpper ? "lower" : "upper";
    }
  }

  return {
    rangeSide,
    inRange: rangeSide === "inside",
    nearEdge,
    edge,
    priceBPerA: price,
    priceLower,
    priceUpper,
    distanceToLowerPct: width > 0 ? (distLower / width) * 100 : null,
    distanceToUpperPct: width > 0 ? (distUpper / width) * 100 : null,
    priceSource: input.priceSource ?? "unknown",
  };
}

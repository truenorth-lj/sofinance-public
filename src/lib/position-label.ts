import { NATIVE_SOL_MINT, USDC_MINT } from "./ids";
import { uiPriceBPerAFromTick } from "./position-performance-math";

export type PositionLabelInput = {
  positionMint: string;
  mintA: string;
  mintB: string;
  symbolA?: string | null;
  symbolB?: string | null;
  tickLower: number;
  tickUpper: number;
  rangeSide?: string | null;
  decimalsA?: number | null;
  decimalsB?: number | null;
  feeTierBps?: number | null;
};

export type PositionLabelMetadata = Record<string, { symbol?: string | null } | undefined>;

const EN_DASH = "–";

/** Short mint for secondary text, e.g. `4PUe…bhEU`. */
export function shortMint(mint: string): string {
  const value = mint.trim();
  if (value.length <= 8) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function tokenSymbol(
  mint: string,
  metadata?: PositionLabelMetadata,
  explicit?: string | null,
): string {
  const fromPosition = explicit?.trim();
  if (fromPosition) return fromPosition;
  const symbol = metadata?.[mint]?.symbol?.trim();
  if (symbol) return symbol;
  if (mint === USDC_MINT) return "USDC";
  if (mint === NATIVE_SOL_MINT) return "WSOL";
  return shortMint(mint);
}

export function formatRangeStatus(rangeSide: string | null | undefined): string | null {
  switch (rangeSide) {
    case "inside":
      return "In range";
    case "above":
      return "Above range";
    case "below":
      return "Below range";
    default:
      return null;
  }
}

export function formatFeeTier(feeTierBps: number | null | undefined): string | null {
  if (feeTierBps === null || feeTierBps === undefined || !Number.isFinite(feeTierBps) || feeTierBps < 0) {
    return null;
  }
  const pct = feeTierBps / 100;
  const text = Number.isInteger(pct) ? String(pct) : trimTrailingZeros(pct.toFixed(4));
  return `${text}% fee`;
}

/**
 * Human price range in pool UI units (B per 1 A), matching the Positions page
 * `sqrtPriceX64ToPrice(..., decimalsA, decimalsB)` orientation.
 */
export function formatPositionPriceRange(position: Pick<
  PositionLabelInput,
  "tickLower" | "tickUpper" | "decimalsA" | "decimalsB"
>): string {
  const { tickLower, tickUpper, decimalsA, decimalsB } = position;
  if (
    Number.isInteger(decimalsA) &&
    Number.isInteger(decimalsB) &&
    (decimalsA as number) >= 0 &&
    (decimalsB as number) >= 0 &&
    Number.isInteger(tickLower) &&
    Number.isInteger(tickUpper)
  ) {
    try {
      const lower = uiPriceBPerAFromTick(tickLower, decimalsA as number, decimalsB as number);
      const upper = uiPriceBPerAFromTick(tickUpper, decimalsA as number, decimalsB as number);
      const digits = rangeFractionDigits(lower, upper);
      return `${formatUiPrice(lower, digits)}${EN_DASH}${formatUiPrice(upper, digits)}`;
    } catch {
      // Fall through to tick text when the mid is not a positive finite number.
    }
  }
  return `${formatTick(tickLower)} to ${formatTick(tickUpper)}`;
}

/** `SPCXx/SPCX · 0.01% fee · range 1.0012–1.0016 · In range · #4PUe…bhEU` */
export function formatPositionLabel(
  position: PositionLabelInput,
  metadata?: PositionLabelMetadata,
): string {
  const parts = [
    `${tokenSymbol(position.mintA, metadata, position.symbolA)}/${tokenSymbol(position.mintB, metadata, position.symbolB)}`,
  ];
  const fee = formatFeeTier(position.feeTierBps);
  if (fee) parts.push(fee);
  parts.push(`range ${formatPositionPriceRange(position)}`);
  const status = formatRangeStatus(position.rangeSide);
  if (status) parts.push(status);
  parts.push(`#${shortMint(position.positionMint)}`);
  return parts.join(" · ");
}

function rangeFractionDigits(lower: number, upper: number): number {
  const span = Math.abs(upper - lower);
  if (Number.isFinite(span) && span > 0) {
    return Math.min(8, Math.max(4, Math.ceil(-Math.log10(span))));
  }
  const magnitude = Math.max(Math.abs(lower), Math.abs(upper));
  if (!Number.isFinite(magnitude) || magnitude === 0) return 4;
  if (magnitude >= 1000) return 2;
  if (magnitude >= 1) return 4;
  return Math.min(8, Math.max(4, Math.ceil(-Math.log10(magnitude)) + 2));
}

function formatUiPrice(price: number, fractionDigits: number): string {
  if (!Number.isFinite(price) || price <= 0) return "—";
  return price.toFixed(fractionDigits);
}

function formatTick(tick: number): string {
  return Number.isFinite(tick) ? String(tick) : "—";
}

function trimTrailingZeros(value: string): string {
  if (!value.includes(".")) return value;
  return value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

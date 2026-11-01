/**
 * Price ranges for positions whose pools only give ticks (Robinhood Chain Uniswap v4). PM decision Q3: quote in the stable/USD
 * side (like Solana pools); when neither or both sides are USD stables, quote token1 per token0. 5 significant digits for
 * stable pairs (StablePair pools, e.g. SPCX/SPCXon, or USD/USD), 4 otherwise.
 */
const USD_STABLES = new Set(["USDC", "USDT", "PYUSD", "USDE", "USDG", "DAI", "USDS", "USD1", "FDUSD"]);
export const isUsdStable = (symbol: string | null | undefined) => Boolean(symbol && USD_STABLES.has(symbol.trim().toUpperCase()));

export type TickRangeInput = {
  tickLower: number; tickUpper: number;
  token0: { symbol: string; decimals: number }; token1: { symbol: string; decimals: number };
  /** StablePair hook pool (two versions of one asset). */
  stablePair?: boolean;
};

export type PriceRange = { lower: string; upper: string; base: string; quote: string; text: string };

/** token1 per token0 at a tick, in human units. */
export function priceAtTick(tick: number, decimals0: number, decimals1: number): number {
  return Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1);
}

export function significant(value: number, digits: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  return trim(value.toPrecision(digits));
}
const trim = (text: string) => text.includes("e") ? text : text.includes(".") ? text.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") : text;

export function formatTickPriceRange(input: TickRangeInput): PriceRange | null {
  const { tickLower, tickUpper, token0, token1 } = input;
  if (![tickLower, tickUpper, token0.decimals, token1.decimals].every(Number.isInteger)) return null;
  const p0 = priceAtTick(tickLower, token0.decimals, token1.decimals);
  const p1 = priceAtTick(tickUpper, token0.decimals, token1.decimals);
  if (![p0, p1].every((p) => Number.isFinite(p) && p > 0)) return null;
  // Quote in the USD side when exactly token0 is a USD stable: invert to token0 per token1.
  const invert = isUsdStable(token0.symbol) && !isUsdStable(token1.symbol);
  const [lo, hi] = invert ? [1 / p1, 1 / p0] : [p0, p1];
  const base = invert ? token1.symbol : token0.symbol;
  const quote = invert ? token0.symbol : token1.symbol;
  const stable = Boolean(input.stablePair) || (isUsdStable(token0.symbol) && isUsdStable(token1.symbol));
  const digits = stable ? 5 : 4;
  const lower = significant(lo, digits), upper = significant(hi, digits);
  return { lower, upper, base, quote, text: `${lower}–${upper} ${quote} per ${base}` };
}

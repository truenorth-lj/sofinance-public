import "@/lib/engine-host";
import "server-only";

import { scrubSensitiveText } from "@/lib/sentry/scrub";
import { getJupiterApiKey } from "@sofinance/engine/config/server-env";
import { SLIPPAGE_BPS, USDC_MINT } from "@sofinance/engine/ids";
import { meteoraBinPrice } from "@sofinance/engine/protocols/meteora/accounts";
import { meteoraSpotBinCounts, meteoraSpotMinimumInput, meteoraSpotRoundsToZero, type MeteoraSideRate } from "@sofinance/engine/protocols/meteora/open";
import { feeSwapLeg } from "@sofinance/engine/swap/leg";
import { fetchJupiterPricesUsd } from "@sofinance/engine/token-prices";
import type { DepositMinimum } from "../adapter";
import type { MeteoraOpenPlan } from "./open.server";

/** Raw units of `side.mint` the deposit's swap leg would hand to `add_liquidity_by_strategy2` (Jupiter minOut, after fee). */
export type MeteoraLegQuote = (input: { owner: string; inputMint: string; outputMint: string; spend: bigint; feeBps: number }) => Promise<bigint>;
/** USD price per whole token, by mint (missing = unknown). */
export type MeteoraUsdPrices = (mints: string[]) => Promise<Map<string, number>>;

export const jupiterLegQuote: MeteoraLegQuote = async ({ owner, inputMint, outputMint, spend, feeBps }) =>
  (await feeSwapLeg({ wallet: owner, inputMint, outputMint, spend, feeBps, inputFee: feeBps > 0, build: false })).minOut;
export const jupiterUsdPrices: MeteoraUsdPrices = (mints) => fetchJupiterPricesUsd(mints, fetch, getJupiterApiKey());

/**
 * Extra haircut on a swapped side's rate, on top of the platform fee and the 0.5% slippage limit: covers the gap between
 * the USD price and the route the build actually takes, and route dust (a venue that fills a few raw short).
 */
export const MINIMUM_MARGIN_BPS = 200;
/** Stable inputs the rule prices at $1 without a lookup (the only non-pool input Meteora opens accept is USDC). */
const STABLE_INPUT_DECIMALS: Record<string, number> = { [USDC_MINT]: 6 };
const RATE_SCALE = 10n ** 12n;

const rateOf = (outPerInput: number): MeteoraSideRate | undefined =>
  Number.isFinite(outPerInput) && outPerInput > 0 ? { spend: RATE_SCALE, out: BigInt(Math.floor(outPerInput * Number(RATE_SCALE))) } : undefined;

/**
 * Quote-free rates (raw pool-token out per raw input) for each side, from on-chain state:
 *  - a side whose mint is the input is kept 1:1;
 *  - input X ↔ side Y (or Y ↔ X) converts at the active bin's price, raw Y per raw X = (1 + binStep/10⁴)^activeId;
 *  - a stable input (USDC) is priced at $1 against ONE pool token's USD price, and the other side follows the active
 *    bin price from there (so only one off-chain number is used, and never a swap route).
 * Every swapped side loses the platform fee, the slippage limit and `MINIMUM_MARGIN_BPS`. Null when it can't price.
 */
async function ruleRates(plan: MeteoraOpenPlan, usdPrices: MeteoraUsdPrices): Promise<{ x?: MeteoraSideRate; y?: MeteoraSideRate } | null> {
  const { lbPair, decimalsX, decimalsY } = plan.pool;
  const price = meteoraBinPrice(lbPair.activeId, lbPair.binStep); // raw Y per raw X
  const keep = 1 - (plan.legBps + SLIPPAGE_BPS + MINIMUM_MARGIN_BPS) / 10_000;
  let xPerIn: number; let yPerIn: number;
  if (plan.inputMint === lbPair.tokenXMint) { xPerIn = 1; yPerIn = price * keep; }
  else if (plan.inputMint === lbPair.tokenYMint) { yPerIn = 1; xPerIn = (1 / price) * keep; }
  else {
    const inDecimals = STABLE_INPUT_DECIMALS[plan.inputMint];
    if (inDecimals === undefined) return null;
    const usd = await usdPrices([lbPair.tokenXMint, lbPair.tokenYMint]);
    const px = usd.get(lbPair.tokenXMint); const py = usd.get(lbPair.tokenYMint);
    // raw X per raw input = (1 USD / 10^inDec) / (pX USD / 10^decX)
    const fromX = px && px > 0 ? 10 ** (decimalsX - inDecimals) / px : NaN;
    const fromY = py && py > 0 ? (10 ** (decimalsY - inDecimals) / py) / price : NaN;
    const rawX = Number.isFinite(fromX) ? fromX : fromY;
    if (!Number.isFinite(rawX) || rawX <= 0) return null;
    xPerIn = rawX * keep; yPerIn = rawX * price * keep;
  }
  return { x: rateOf(xPerIn), y: rateOf(yPerIn) };
}

/**
 * The one "too small for this range" check for Open and Add (same plan, same SpotImBalanced split: each bin of a side
 * gets floor(amount / bins) raw, so a small deposit adds nothing).
 *  1. Rule (primary, no swap quote): `minimumRaw` from the active bin price and the X/Y bin counts, so every bin gets
 *     ≥ 1 raw after fee, slippage and margin. Too small when the amount is below it.
 *  2. Jupiter leg quote of this exact amount (supplement): if its minOut would still round a side to 0, it is too small
 *     too, and the minimum is raised to what the quoted rate needs. A failed quote is reported (`quoteChecked: false`
 *     and a log line), never skipped silently; the rule still decides.
 * If neither can price the input, the result is `unavailable` (too small, Open / Add disabled), never "fine".
 * The build's simulation ("added no liquidity") stays the last backstop.
 */
export async function meteoraDepositMinimum(
  plan: MeteoraOpenPlan, owner: string, quoteLeg: MeteoraLegQuote = jupiterLegQuote, usdPrices: MeteoraUsdPrices = jupiterUsdPrices,
): Promise<DepositMinimum> {
  const { activeId, tokenXMint, tokenYMint } = plan.pool.lbPair;
  const range = { activeId, lowerBinId: plan.lowerBinId, upperBinId: plan.upperBinId };
  const bins = meteoraSpotBinCounts(activeId, plan.lowerBinId, plan.upperBinId);
  const rates = await ruleRates(plan, usdPrices).catch(() => null);
  const ruleMinimum = rates ? meteoraSpotMinimumInput({ ...range, rates }) : null;

  const spendOf = (side: "x" | "y") => plan.sides.find((item) => item.side === side)?.spend ?? 0n;
  let quoted: { x: bigint; y: bigint } | null = null;
  try {
    const outFor = async (side: "x" | "y", mint: string) => {
      const spend = spendOf(side);
      if (!bins[side] || spend <= 0n) return 0n;
      return mint === plan.inputMint ? spend : quoteLeg({ owner, inputMint: plan.inputMint, outputMint: mint, spend, feeBps: plan.legBps });
    };
    const [x, y] = await Promise.all([outFor("x", tokenXMint), outFor("y", tokenYMint)]);
    quoted = { x, y };
  } catch (error) {
    // eslint-disable-next-line no-console -- deliberate warn (not error): the on-chain rule still decides, but the skipped supplement must be visible
    console.warn(scrubSensitiveText(`[meteora-dlmm] deposit-minimum leg quote failed for pool ${plan.pool.poolId}; using the on-chain rule only: ${error instanceof Error ? error.message : String(error)}`));
  }

  if (ruleMinimum === null && !quoted) return { token: plan.inputMint, tooSmall: true, minimumRaw: null, quoteChecked: false, unavailable: true };
  const quoteTooSmall = quoted ? meteoraSpotRoundsToZero(quoted.x, quoted.y, bins) : false;
  let minimum = ruleMinimum;
  if (quoteTooSmall && quoted) {
    // Raise the minimum to what the quoted rate needs (sides the quote priced at 0 keep the rule's rate).
    const quotedRate = (side: "x" | "y", out: bigint) => (out > 0n ? { spend: spendOf(side), out } : rates?.[side]);
    const fromQuote = meteoraSpotMinimumInput({ ...range, rates: { x: quotedRate("x", quoted.x), y: quotedRate("y", quoted.y) } });
    if (fromQuote !== null && (minimum === null || fromQuote > minimum)) minimum = fromQuote;
    if (minimum !== null && minimum <= plan.amount) minimum = plan.amount + 1n;
  }
  const tooSmall = quoteTooSmall || (minimum !== null && plan.amount < minimum);
  return { token: plan.inputMint, tooSmall, minimumRaw: minimum === null ? null : minimum.toString(), quoteChecked: quoted !== null };
}

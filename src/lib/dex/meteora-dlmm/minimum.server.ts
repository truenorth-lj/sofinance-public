import "@/lib/engine-host";
import "server-only";

import { meteoraSpotBinCounts, meteoraSpotMinimumInput, meteoraSpotRoundsToZero, type MeteoraSideRate } from "@sofinance/engine/protocols/meteora/open";
import { feeSwapLeg } from "@sofinance/engine/swap/leg";
import type { DepositMinimum } from "../adapter";
import type { MeteoraOpenPlan } from "./open.server";

/** Below this many raw units out per bin, a quote's rate is too coarse to extrapolate from: quote a bigger probe. */
const PROBE_OUT_PER_BIN = 50n;

/** Raw units of `side.mint` the deposit's swap leg would hand to `add_liquidity_by_strategy2` (Jupiter minOut, after fee). */
export type MeteoraLegQuote = (input: { owner: string; inputMint: string; outputMint: string; spend: bigint; feeBps: number }) => Promise<bigint>;

export const jupiterLegQuote: MeteoraLegQuote = async ({ owner, inputMint, outputMint, spend, feeBps }) =>
  (await feeSwapLeg({ wallet: owner, inputMint, outputMint, spend, feeBps, inputFee: feeBps > 0, build: false })).minOut;

/**
 * Open and Add share this check (same plan, same SpotImBalanced split). SpotImBalanced gives each bin
 * floor(amount / bins) raw, where amount is the swap leg's minOut (or the kept input), so a small deposit adds nothing.
 * `tooSmall` uses the quoted minOut of this exact amount; `minimumRaw` extrapolates each side's rate (with a bigger
 * probe quote when the real one is too coarse). Best effort: when quoting fails it returns undefined, and the build's
 * simulation check ("added no liquidity") still refuses a deposit that adds nothing.
 */
export async function meteoraDepositMinimum(plan: MeteoraOpenPlan, owner: string, quoteLeg: MeteoraLegQuote = jupiterLegQuote): Promise<DepositMinimum | undefined> {
  try {
    const { activeId, tokenXMint, tokenYMint } = plan.pool.lbPair;
    const bins = meteoraSpotBinCounts(activeId, plan.lowerBinId, plan.upperBinId);
    const outFor = (mint: string, spend: bigint) => (spend <= 0n ? Promise.resolve(0n)
      : mint === plan.inputMint ? Promise.resolve(spend)
      : quoteLeg({ owner, inputMint: plan.inputMint, outputMint: mint, spend, feeBps: plan.legBps }));
    const spendOf = (side: "x" | "y") => plan.sides.find((item) => item.side === side)?.spend ?? 0n;
    const sides = [{ side: "x" as const, mint: tokenXMint }, { side: "y" as const, mint: tokenYMint }];
    const quoted = await Promise.all(sides.map(async ({ side, mint }) => ({ side, mint, spend: spendOf(side), out: bins[side] ? await outFor(mint, spendOf(side)) : 0n })));
    const amountOut = (side: "x" | "y") => quoted.find((item) => item.side === side)!.out;
    const tooSmall = meteoraSpotRoundsToZero(amountOut("x"), amountOut("y"), bins);
    if (!tooSmall) return { token: plan.inputMint, tooSmall: false, minimumRaw: null };
    const rates: { x?: MeteoraSideRate; y?: MeteoraSideRate } = {};
    await Promise.all(quoted.map(async ({ side, mint, spend, out }) => {
      const count = BigInt(bins[side]);
      if (count === 0n) return;
      if (out >= PROBE_OUT_PER_BIN * count) { rates[side] = { spend, out }; return; }
      // Too coarse (or nothing quoted): a probe big enough for ~50 raw per bin, priced at the same leg.
      const base = spend > 0n ? spend : 1n;
      const multiplier = out > 0n ? (PROBE_OUT_PER_BIN * count + out - 1n) / out : PROBE_OUT_PER_BIN * count;
      const probe = base * (multiplier > 1n ? multiplier : 1n);
      rates[side] = { spend: probe, out: await outFor(mint, probe) };
    }));
    const minimum = meteoraSpotMinimumInput({ activeId, lowerBinId: plan.lowerBinId, upperBinId: plan.upperBinId, rates });
    return { token: plan.inputMint, tooSmall: true, minimumRaw: minimum === null ? null : minimum.toString() };
  } catch {
    return undefined;
  }
}

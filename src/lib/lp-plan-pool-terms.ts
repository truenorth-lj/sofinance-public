import type { Capability } from "@/lib/unified-positions/model";
import type { ExitAsset } from "./lp-intent";
import { feeRuleBps, type DexDescriptor } from "./dex/types";
import Decimal from "decimal.js";
import { buildPlanComparison, PLAN_SWAP_COST_BPS, PLAN_OPEN_COST_BPS, planEntryCost, planOpenCostPctLabel, type PlanYieldComparison } from "./lp-plan-yield";
import { lpFeeFraction } from "./range-apr/build-model";

/**
 * What the Plan page assumes about the chosen pool's DEX: the day-0 opening cost, the assets you can exit to and whether
 * the pool can be opened from SoFinance. Everything comes from the DEX descriptor (fee policy, rent model,
 * `withdrawOutputs`, `open`), so the page never branches on a protocol id.
 *
 * Pools without a registered descriptor (Raydium CLMM today) keep the original planning assumption: about 1% of the
 * deposit for creating the position and adding liquidity, exit to USDC or the tokens, and the "Create a position" link.
 */
export type PlanOpenCost = {
  /** Subtracted from the deposit on day 0 (basis points of the deposit). */
  bps: number;
  /** Short form for the "Opening cost, day 0" row, after the USDC amount, e.g. "about 1%". */
  rowLabel: string;
  /** Second line under that row (rent set aside and refunded), or null. */
  rowNote: string | null;
  /** "Best case after 30 days: … net, once {summary}." */
  summary: string;
  /** The break-even footnote's description of what day 0 pays. */
  breakEven: string;
  /** The chart caption's sentence about opening costs. */
  chart: string;
};

/** Closing cost for one exit choice: basis points of what the position is worth when you close it. */
export type PlanExitCost = {
  bps: number;
  /** Short form, e.g. "about 1% to swap back to USDC". */
  label: string;
};

export type PlanPoolTerms = {
  openCost: PlanOpenCost;
  /** Share of the pool's gross swap fees an LP keeps after the DEX's cut; the projection scales the pool fee APR by it. */
  lpFeeShare: number;
  /** "after Raydium's usual 16% cut" — what `lpFeeShare` takes out, for the copy. */
  lpShareLabel: string;
  /** Closing cost per exit choice. */
  exitCost: Readonly<Record<ExitAsset, PlanExitCost>>;
  /** Exit choices this DEX can pay out, in display order. */
  exits: readonly ExitAsset[];
  /** "Exit to" row text when the exit is the pool tokens and the pair's symbols are known; null keeps the generic text. */
  tokensExitLabel: string | null;
  /** The "Create a position in this pool" link: unsupported greys it with the reason. */
  open: Capability;
};

const LEGACY_COST: PlanOpenCost = (() => {
  const pct = planOpenCostPctLabel(PLAN_OPEN_COST_BPS);
  return {
    bps: PLAN_OPEN_COST_BPS,
    rowLabel: `about ${pct}%`,
    rowNote: null,
    summary: `about ${pct}% of the deposit is spent opening the position on day 0`,
    breakEven: `the typical cost of creating the position and adding liquidity (around ${pct}% of the deposit)`,
    chart: `Creating the position and adding liquidity typically costs around ${pct}%, and Day 0 subtracts that from the deposit; network fees are ignored.`,
  };
})();

/**
 * Registered DEX: day 0 swaps the whole USDC deposit into the pool tokens, so it pays the shared swap-cost estimate
 * (`PLAN_SWAP_COST_BPS`, the same one Raydium's open uses) plus the platform fee of its `open` rule. Rent set aside in
 * SOL and refunded on a full withdraw is stated, not subtracted.
 */
function descriptorCost(descriptor: DexDescriptor): PlanOpenCost {
  const rule = descriptor.meta.feePolicy.open;
  const feeBps = feeRuleBps(rule);
  const bps = feeBps + PLAN_SWAP_COST_BPS;
  const pct = planOpenCostPctLabel(feeBps);
  const swapPct = planOpenCostPctLabel(PLAN_SWAP_COST_BPS);
  const fee = feeBps === 0
    ? `about ${swapPct}% to swap the deposit into the pool tokens, with no platform fee`
    : rule.kind === "swap-input-bps"
      ? `about ${swapPct}% to swap the deposit into the pool tokens plus the ${pct}% platform fee on the swapped part (all of a USDC deposit)`
      : `about ${swapPct}% to swap the deposit into the pool tokens plus the ${pct}% platform fee`;
  const rent = descriptor.meta.rent;
  const rentSol = rent?.planEstimateSol;
  const rentLine = rent && rentSol
    ? `about ${rentSol} SOL of position rent is set aside on top${rent.refundableOnClose ? " and refunded when you fully withdraw, so it is not subtracted" : ""}`
    : null;
  const capitalized = rentLine ? rentLine.charAt(0).toUpperCase() + rentLine.slice(1) : null;
  return {
    bps,
    rowLabel: feeBps === 0 ? `about ${swapPct}% swap cost, no platform fee` : `about ${swapPct}% swap cost plus the ${pct}% platform fee`,
    rowNote: rent && rentSol ? `Plus about ${rentSol} SOL position rent${rent.refundableOnClose ? ", refunded on full close" : ""}` : null,
    summary: `${fee} is paid on day 0`,
    breakEven: `the opening cost: ${fee}${rentLine ? `; ${rentLine}` : ""}`,
    chart: `Opening costs ${fee}, and Day 0 subtracts that from the deposit.${capitalized ? ` ${capitalized}.` : ""} Network fees are ignored.`,
  };
}

const LEGACY_EXITS: readonly ExitAsset[] = ["usdc", "tokens"];

/**
 * Raydium CLMM (no descriptor yet): LPs keep what is left after the usual 12% protocol and 4% fund cut, the same
 * default the range APR uses (`lpFeeFraction`). Closing to USDC swaps both tokens back, assumed to cost about what
 * opening did; taking the pool tokens needs no swap.
 */
const LEGACY_LP_FEE_SHARE = lpFeeFraction(null, null);
const LEGACY_EXIT_COST: Readonly<Record<ExitAsset, PlanExitCost>> = {
  usdc: { bps: PLAN_SWAP_COST_BPS, label: `about ${planOpenCostPctLabel(PLAN_SWAP_COST_BPS)}% to swap back to USDC` },
  tokens: { bps: 0, label: "no swap when you take the pool tokens" },
};

const cutLabel = (share: number, who: string) =>
  share >= 1 ? "with no protocol cut" : `after ${who}'s ${planOpenCostPctLabel(Math.round((1 - share) * 10_000))}% cut`;

/**
 * Registered DEX: the platform fee of each withdraw rule. Closing to USDC also swaps both tokens back, so it adds the
 * shared swap-cost estimate (`PLAN_SWAP_COST_BPS`, the same one Raydium's close uses); taking the pool tokens
 * needs no swap.
 */
function descriptorExitCost(descriptor: DexDescriptor): Readonly<Record<ExitAsset, PlanExitCost>> {
  const usdcFee = feeRuleBps(descriptor.meta.feePolicy.withdrawUsdc);
  const tokens = feeRuleBps(descriptor.meta.feePolicy.withdrawPoolTokens);
  const label = (bps: number, what: string) => (bps === 0 ? `no platform fee ${what}` : `${planOpenCostPctLabel(bps)}% platform fee ${what}`);
  const swap = `about ${planOpenCostPctLabel(PLAN_SWAP_COST_BPS)}% to swap back to USDC`;
  return {
    usdc: { bps: usdcFee + PLAN_SWAP_COST_BPS, label: usdcFee === 0 ? swap : `${swap} plus the ${planOpenCostPctLabel(usdcFee)}% platform fee` },
    tokens: { bps: tokens, label: label(tokens, "to take the pool tokens") },
  };
}

export function planPoolTerms(input: {
  descriptor: DexDescriptor | null;
  /** The pool list's own reason it cannot open this pool (`openUnavailableReason`), or null. */
  listOpenReason: string | null;
  symbols?: readonly [string, string];
}): PlanPoolTerms {
  const { descriptor, listOpenReason, symbols } = input;
  const listOpen: Capability = listOpenReason ? { supported: false, reason: listOpenReason } : { supported: true };
  if (!descriptor) {
    return {
      openCost: LEGACY_COST,
      lpFeeShare: LEGACY_LP_FEE_SHARE,
      lpShareLabel: cutLabel(LEGACY_LP_FEE_SHARE, "Raydium"),
      exitCost: LEGACY_EXIT_COST,
      exits: LEGACY_EXITS,
      tokensExitLabel: null,
      open: listOpen,
    };
  }
  const caps = descriptor.capabilities;
  const outputs = caps.withdraw.supported ? caps.withdrawOutputs : [];
  const exits = LEGACY_EXITS.filter((exit) => outputs.includes(exit === "usdc" ? "usdc" : "pool-tokens"));
  const lpFeeShare = descriptor.meta.planLpFeeShare ?? 1;
  return {
    openCost: descriptorCost(descriptor),
    lpFeeShare,
    lpShareLabel: cutLabel(lpFeeShare, descriptor.displayName),
    exitCost: descriptorExitCost(descriptor),
    exits: exits.length ? exits : ["tokens"],
    tokensExitLabel: symbols ? `${symbols[0]} and ${symbols[1]}, the pool tokens` : null,
    open: caps.open.supported ? listOpen : caps.open,
  };
}

/**
 * The plan for one pool and one exit: the window's pool fee APR scaled to the LP's share, the DEX's opening cost on day
 * 0 and its closing cost for that exit. The Plan page and the pools-page calculator both project through here.
 *
 * When the window knows the pool's real fees (`poolFeesPerDayUsd`), each day's fees are capped at what the pool's LPs
 * actually took per day, split by your share of the pool once your deposit is in (`poolTvlUsd` is the TVL before it).
 * An average APR inflated by one busy day on a nearly empty pool cannot then project more than the pool ever paid.
 */
export function projectPoolPlan(input: {
  capital: string;
  days: number;
  window: { aprPct: string; sampleDays: number; windowDays: number; poolFeesPerDayUsd?: string };
  terms: PlanPoolTerms;
  exit: ExitAsset;
  /** Pool TVL in USD today; missing or unknown caps at the pool's whole fee income. */
  poolTvlUsd?: number | null;
}): PlanYieldComparison {
  const { capital, days, window, terms, exit, poolTvlUsd } = input;
  const tvl = poolTvlUsd !== undefined && poolTvlUsd !== null && Number.isFinite(poolTvlUsd) && poolTvlUsd > 0 ? poolTvlUsd : 0;
  return buildPlanComparison({
    capital,
    days,
    aprPct: new Decimal(window.aprPct).mul(terms.lpFeeShare).toFixed(),
    sampleDays: window.sampleDays,
    aprWindowDays: window.windowDays,
    entryCost: planEntryCost(capital, terms.openCost.bps),
    exitCostBps: terms.exitCost[exit].bps,
    feeCap: window.poolFeesPerDayUsd === undefined ? undefined : {
      poolLpFeesPerDayUsd: new Decimal(window.poolFeesPerDayUsd).mul(terms.lpFeeShare).toFixed(),
      poolTvlUsd: new Decimal(tvl).toFixed(),
    },
  });
}

/** Terms for a pool with no registered DEX descriptor (and before the pairs list has loaded). */
export const LEGACY_PLAN_TERMS: PlanPoolTerms = planPoolTerms({ descriptor: null, listOpenReason: null });

/** The exit the page shows: the chosen one when this DEX pays it out, else the DEX's first. */
export function effectiveExit(chosen: ExitAsset, exits: readonly ExitAsset[]): ExitAsset {
  return exits.includes(chosen) ? chosen : exits[0] ?? chosen;
}

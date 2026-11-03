import type { DexFeeStrategy } from "./adapter";
import { feeRuleBps, NO_FEE, type FeeOp, type FeePolicy, type FeeRule } from "./types";

/** Highest rate any rule may declare (same ceiling as the engine's MAX_SWAP_FEE_BPS). */
export const MAX_DEX_FEE_BPS = 100;

/** A policy that charges nothing anywhere (the default for a DEX until its rules are decided). */
export const NO_FEE_POLICY: FeePolicy = Object.freeze({
  open: NO_FEE, add: NO_FEE, compound: NO_FEE, claim: NO_FEE, withdrawPoolTokens: NO_FEE, withdrawUsdc: NO_FEE,
});

/** Problems with a declared policy; empty when it is valid. */
export function feePolicyProblems(policy: FeePolicy): string[] {
  const problems: string[] = [];
  for (const [op, rule] of Object.entries(policy) as [FeeOp, FeeRule][]) {
    const bps = feeRuleBps(rule);
    if (!Number.isInteger(bps) || bps < 0 || bps > MAX_DEX_FEE_BPS) problems.push(`${op}: ${bps} bps is outside 0..${MAX_DEX_FEE_BPS}`);
    if (rule.kind === "harvest-bps" && op !== "compound") problems.push(`${op}: harvest fees only apply to compound`);
  }
  return problems;
}

/** The plain strategy: fee = floor(base × bps / 10 000) for the op's rule. */
export function bpsFeeStrategy(policy: FeePolicy): DexFeeStrategy {
  const problems = feePolicyProblems(policy);
  if (problems.length) throw new Error(`Invalid DEX fee policy: ${problems.join("; ")}`);
  return Object.freeze({
    policy,
    feeFor(op: FeeOp, baseRaw: bigint): bigint {
      if (baseRaw <= 0n) return 0n;
      return (baseRaw * BigInt(feeRuleBps(policy[op]))) / 10_000n;
    },
  });
}

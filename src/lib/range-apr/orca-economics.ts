/** Pool-level economics from Orca API v2 `/pools/{address}` (pure parser, allowlisted pools only). */
import { ORCA_API_V2 } from "@sofinance/engine/protocols/orca/constants";
import { parseOrcaPool } from "@sofinance/engine/protocols/orca/discovery";
import type { HttpPoolEconomicsSource } from "../pool-range-apr";
import type { PoolEconomics } from "./raydium-economics";

const DAYS_PER_YEAR = 365;

function num(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Maps an Orca pool onto the economics shape the range-APR model already uses.
 * - feeRate: fraction (Orca 100 = 1 bp → 0.0001).
 * - protocolFeeRate: parts per million of the trade fee (Orca 1300 bps → 130_000), no fund cut, so the
 *   LP share is 87% for cbBTC/WBTC.
 * - mintAmountA/B: UI units from Orca's raw vault balances.
 * - dayFeeApr / weekFeeApr: gross whole-pool fee APR in percent (like Raydium's published `feeApr`).
 */
export function parseOrcaPoolEconomics(body: unknown): PoolEconomics | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = (body as { data?: unknown }).data;
  const summary = parseOrcaPool(raw);
  if (!summary || summary.decimalsA <= 0 || summary.decimalsB <= 0) return null;
  const pool = raw as Record<string, unknown>;
  const balanceA = num(pool.tokenBalanceA), balanceB = num(pool.tokenBalanceB);
  const { tvlUsd, price } = summary;
  if (tvlUsd === null || tvlUsd < 0 || price === null || !(price > 0) || balanceA === null || balanceB === null) return null;
  const apr = (fees: number | null, days: number) =>
    fees === null || !(tvlUsd > 0) ? null : (fees / days / tvlUsd) * DAYS_PER_YEAR * 100;
  return {
    mintA: summary.mintA, mintB: summary.mintB, decimalsA: summary.decimalsA, decimalsB: summary.decimalsB,
    feeRate: summary.feeRate, tvlUsd, price,
    mintAmountA: balanceA / 10 ** summary.decimalsA,
    mintAmountB: balanceB / 10 ** summary.decimalsB,
    protocolFeeRate: Math.round(summary.protocolFeeShare * 1_000_000),
    fundFeeRate: 0,
    weekVolumeUsd: summary.volume7dUsd,
    dayFeeApr: apr(summary.fees24hUsd, 1),
    weekFeeApr: apr(summary.fees7dUsd, 7),
  };
}

export const ORCA_ECONOMICS_SOURCE: HttpPoolEconomicsSource = {
  name: "Orca",
  protocol: "orca-whirlpool",
  url: (id) => `${ORCA_API_V2}/pools/${id}`,
  parse: parseOrcaPoolEconomics,
  source: `${ORCA_API_V2}/pools/{address} (feeRate, protocolFeeRate, TVL, vault balances)`,
};

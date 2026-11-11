/** Pool-level economics from the Meteora datapi `/pools/{address}` (pure parser; allowlisted pools or an explicit spec). */
import { METEORA_DLMM_DATAPI, type MeteoraPoolSpec } from "@sofinance/engine/protocols/meteora/constants";
import { parseMeteoraPool } from "@sofinance/engine/protocols/meteora/discovery";
import type { HttpPoolEconomicsSource } from "../pool-range-apr";
import type { PoolEconomics } from "./raydium-economics";

const DAYS_PER_YEAR = 365;

function num(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Maps a Meteora DLMM pool (token X → A, token Y → B) onto the economics shape the range-APR model uses.
 * - feeRate: the base fee as a fraction (base_fee_pct 0.01 → 0.0001). The variable fee is left out.
 * - protocolFeeRate: parts per million from datapi `protocol_fee_pct`. `assembleMeteoraRangeApr` replaces the
 *   fee rate and protocol share with the on-chain LbPair values, which are authoritative.
 * - mintAmountA/B: UI token amounts; weekVolumeUsd: null (datapi only publishes up to 24h).
 * - dayFeeApr: gross whole-pool 24h fee APR in percent; weekFeeApr: null.
 */
export function parseMeteoraPoolEconomics(body: unknown, spec?: MeteoraPoolSpec): PoolEconomics | null {
  const summary = parseMeteoraPool(body, spec);
  if (!summary || summary.decimalsX <= 0 || summary.decimalsY <= 0) return null;
  const pool = body as Record<string, unknown>;
  const amountX = num(pool.token_x_amount), amountY = num(pool.token_y_amount);
  const { tvlUsd, price } = summary;
  if (tvlUsd === null || tvlUsd < 0 || price === null || !(price > 0) || amountX === null || amountY === null || amountX < 0 || amountY < 0) return null;
  return {
    mintA: summary.mintX, mintB: summary.mintY, decimalsA: summary.decimalsX, decimalsB: summary.decimalsY,
    feeRate: summary.baseFeeRate, tvlUsd, price,
    mintAmountA: amountX,
    mintAmountB: amountY,
    protocolFeeRate: Math.round(summary.protocolFeeShare * 1_000_000),
    fundFeeRate: 0,
    weekVolumeUsd: null,
    dayFeeApr: summary.fees24hUsd === null || !(tvlUsd > 0) ? null : (summary.fees24hUsd / tvlUsd) * DAYS_PER_YEAR * 100,
    weekFeeApr: null,
  };
}

/** Economics source gated by the allowlist (no spec) or by one scan-found pool's spec. */
export function meteoraEconomicsSource(spec?: MeteoraPoolSpec): HttpPoolEconomicsSource {
  return {
    name: "Meteora",
    protocol: "meteora-dlmm",
    url: (id) => `${METEORA_DLMM_DATAPI}/pools/${id}`,
    parse: (body) => parseMeteoraPoolEconomics(body, spec),
    source: `${METEORA_DLMM_DATAPI}/pools/{address} (TVL, price, token amounts)`,
  };
}

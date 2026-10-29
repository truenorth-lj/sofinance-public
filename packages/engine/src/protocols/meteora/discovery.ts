import { METEORA_ALLOWLISTED_POOLS, METEORA_DLMM_DATAPI, METEORA_NO_REWARD_MINT, type MeteoraAllowlistedPool } from "./constants";

/**
 * Read-only Meteora DLMM pool discovery (Meteora datapi). Nothing here builds
 * or signs transactions; it only turns allowlisted pools into display data.
 */

export type MeteoraPoolSummary = {
  poolAddress: string;
  spec: MeteoraAllowlistedPool;
  mintX: string;
  mintY: string;
  symbolX: string;
  symbolY: string;
  nameX: string;
  nameY: string;
  decimalsX: number;
  decimalsY: number;
  /** False when the token's freeze authority is still set (as reported by Meteora). */
  freezeAuthorityDisabledX: boolean | null;
  freezeAuthorityDisabledY: boolean | null;
  reserveX: string;
  reserveY: string;
  binStep: number;
  /** Base fee as a fraction (base_fee_pct 0.01 → 0.0001). */
  baseFeeRate: number;
  baseFeeBps: number;
  /** Current dynamic (volatility) fee as a fraction; 0 when calm. */
  dynamicFeeRate: number;
  /** Share of swap fees kept by Meteora (protocol_fee_pct / 100). */
  protocolFeeShare: number;
  /** Token Y per token X. */
  price: number | null;
  tvlUsd: number | null;
  volume24hUsd: number | null;
  /** Gross 24h swap fees (USD) as published by Meteora (includes the protocol share). */
  fees24hUsd: number | null;
  protocolFees24hUsd: number | null;
  /** LP share of the 24h swap fees: gross − protocol fees. */
  lpFees24hUsd: number | null;
  hasFarm: boolean;
  hasRewards: boolean;
  createdAt: string | null;
};

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : null);
const text = (value: unknown) => (typeof value === "string" ? value : "");
const num = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const nonNegative = (value: number | null) => (value !== null && value >= 0 ? value : null);

const ALLOWLIST_BY_ID = new Map(METEORA_ALLOWLISTED_POOLS.map(spec => [spec.poolAddress, spec]));

/**
 * Parse one Meteora datapi pool and apply the gate: allowlisted id, exact X/Y mint
 * order, expected bin step, sane fee config and not blacklisted. Returns null for
 * anything else.
 */
export function parseMeteoraPool(raw: unknown): MeteoraPoolSummary | null {
  const pool = record(raw);
  if (!pool) return null;
  const poolAddress = text(pool.address);
  const spec = ALLOWLIST_BY_ID.get(poolAddress);
  if (!spec) return null;
  const tokenX = record(pool.token_x) ?? {}, tokenY = record(pool.token_y) ?? {};
  const mintX = text(tokenX.address), mintY = text(tokenY.address);
  // X/Y order is part of the pool's identity (it decides which side of the active bin each token sits on).
  if (mintX !== spec.mintX || mintY !== spec.mintY || mintX === mintY) return null;
  if (pool.is_blacklisted !== false) return null;
  const config = record(pool.pool_config) ?? {};
  const binStep = num(config.bin_step), baseFeePct = num(config.base_fee_pct), protocolFeePct = num(config.protocol_fee_pct);
  if (binStep === null || baseFeePct === null || protocolFeePct === null) return null;
  if (binStep !== spec.binStep) return null;
  if (baseFeePct < 0 || baseFeePct >= 100 || protocolFeePct < 0 || protocolFeePct > 100) return null;
  const decimalsX = num(tokenX.decimals), decimalsY = num(tokenY.decimals);
  if (decimalsX === null || decimalsY === null) return null;
  const fees = record(pool.fees) ?? {}, protocolFees = record(pool.protocol_fees) ?? {}, volume = record(pool.volume) ?? {};
  const fees24hUsd = nonNegative(num(fees["24h"]));
  const protocolFees24hUsd = nonNegative(num(protocolFees["24h"]));
  const lpFees24hUsd = fees24hUsd === null
    ? null
    : Math.max(0, fees24hUsd - (protocolFees24hUsd ?? fees24hUsd * protocolFeePct / 100));
  const rewardX = text(pool.reward_mint_x), rewardY = text(pool.reward_mint_y);
  const createdAtMs = num(pool.created_at);
  return {
    poolAddress, spec, mintX, mintY,
    symbolX: text(tokenX.symbol), symbolY: text(tokenY.symbol),
    nameX: text(tokenX.name), nameY: text(tokenY.name),
    decimalsX, decimalsY,
    freezeAuthorityDisabledX: bool(tokenX.freeze_authority_disabled),
    freezeAuthorityDisabledY: bool(tokenY.freeze_authority_disabled),
    reserveX: text(pool.reserve_x), reserveY: text(pool.reserve_y),
    binStep,
    baseFeeRate: baseFeePct / 100,
    baseFeeBps: baseFeePct * 100,
    dynamicFeeRate: (nonNegative(num(pool.dynamic_fee_pct)) ?? 0) / 100,
    protocolFeeShare: protocolFeePct / 100,
    price: nonNegative(num(pool.current_price)),
    tvlUsd: nonNegative(num(pool.tvl)),
    volume24hUsd: nonNegative(num(volume["24h"])),
    fees24hUsd,
    protocolFees24hUsd,
    lpFees24hUsd,
    hasFarm: pool.has_farm === true,
    hasRewards: [rewardX, rewardY].some(mint => mint !== "" && mint !== METEORA_NO_REWARD_MINT),
    createdAt: createdAtMs !== null && createdAtMs > 0 ? new Date(createdAtMs).toISOString() : null,
  };
}

export type FetchMeteoraPoolsOptions = {
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  /** Defaults to every allowlisted pool. */
  poolAddresses?: readonly string[];
  apiBase?: string;
};

/**
 * Fetch allowlisted Meteora pools one by one (the allowlist is tiny; datapi allows
 * 30 RPS). A pool whose request fails or that fails the gate is skipped, never guessed.
 */
export async function fetchMeteoraPools(options: FetchMeteoraPoolsOptions = {}): Promise<MeteoraPoolSummary[]> {
  const fetcher = options.fetcher ?? fetch;
  const base = options.apiBase ?? METEORA_DLMM_DATAPI;
  const ids = (options.poolAddresses ?? METEORA_ALLOWLISTED_POOLS.map(spec => spec.poolAddress)).filter(id => ALLOWLIST_BY_ID.has(id));
  const results = await Promise.all(ids.map(async id => {
    try {
      const response = await fetcher(`${base}/pools/${encodeURIComponent(id)}`, { headers: { accept: "application/json" }, signal: options.signal });
      if (!response.ok) return null;
      const summary = parseMeteoraPool(await response.json());
      return summary?.poolAddress === id ? summary : null;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      return null;
    }
  }));
  return results.filter((summary): summary is MeteoraPoolSummary => summary !== null);
}

import { ORCA_ALLOWLISTED_POOLS, ORCA_API_V2, ORCA_WHIRLPOOLS_CONFIG, type OrcaAllowlistedPool } from "./constants";

/**
 * Read-only Orca Whirlpools pool discovery (Orca API v2). Nothing here builds
 * or signs transactions; it only turns allowlisted pools into display data.
 */

export type OrcaPoolSummary = {
  poolAddress: string;
  spec: OrcaAllowlistedPool;
  mintA: string;
  mintB: string;
  symbolA: string;
  symbolB: string;
  nameA: string;
  nameB: string;
  decimalsA: number;
  decimalsB: number;
  programA: string;
  programB: string;
  tagsA: string[];
  tagsB: string[];
  tickSpacing: number;
  /** Pool fee as a fraction (Orca feeRate is in hundredths of a bp: 100 → 0.0001). */
  feeRate: number;
  feeTierBps: number;
  /** Share of swap fees kept by the Orca protocol (protocolFeeRate / 10_000). */
  protocolFeeShare: number;
  adaptiveFeeEnabled: boolean;
  price: number | null;
  tvlUsd: number | null;
  volume24hUsd: number | null;
  /** Gross 24h swap fees (USD) as published by Orca. */
  fees24hUsd: number | null;
  /** LP share of the 24h swap fees: gross × (1 − protocolFeeShare). */
  lpFees24hUsd: number | null;
  volume7dUsd: number | null;
  fees7dUsd: number | null;
  updatedAt: string | null;
};

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : null);
const text = (value: unknown) => (typeof value === "string" ? value : "");
const num = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const tags = (value: unknown) => (Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === "string") : []);
const sameMints = (spec: OrcaAllowlistedPool, a: string, b: string) =>
  a !== b && ((a === spec.mintA && b === spec.mintB) || (a === spec.mintB && b === spec.mintA));

const ALLOWLIST_BY_ID = new Map(ORCA_ALLOWLISTED_POOLS.map(spec => [spec.poolAddress, spec]));

/**
 * Parse one Orca API v2 pool and apply the gate: allowlisted id, matching mint
 * pair, main WhirlpoolsConfig, plain `whirlpool` type and no Orca warning.
 * Returns null for anything else.
 */
export function parseOrcaPool(raw: unknown): OrcaPoolSummary | null {
  const pool = record(raw);
  if (!pool) return null;
  const poolAddress = text(pool.address);
  const spec = ALLOWLIST_BY_ID.get(poolAddress);
  const tokenA = record(pool.tokenA) ?? {}, tokenB = record(pool.tokenB) ?? {};
  const mintA = text(pool.tokenMintA) || text(tokenA.address);
  const mintB = text(pool.tokenMintB) || text(tokenB.address);
  if (!spec || !sameMints(spec, mintA, mintB)) return null;
  if (text(pool.whirlpoolsConfig) !== ORCA_WHIRLPOOLS_CONFIG) return null;
  if (pool.poolType !== undefined && pool.poolType !== "whirlpool") return null;
  if (pool.hasWarning === true) return null;
  const feeRateRaw = num(pool.feeRate), protocolFeeRate = num(pool.protocolFeeRate), tickSpacing = num(pool.tickSpacing);
  if (feeRateRaw === null || protocolFeeRate === null || tickSpacing === null) return null;
  if (feeRateRaw < 0 || feeRateRaw >= 1_000_000 || protocolFeeRate < 0 || protocolFeeRate > 10_000) return null;
  const stats = record(pool.stats) ?? {}, day = record(stats["24h"]) ?? {}, week = record(stats["7d"]) ?? {};
  const protocolFeeShare = protocolFeeRate / 10_000;
  const fees24hUsd = num(day.fees);
  return {
    poolAddress, spec, mintA, mintB,
    symbolA: text(tokenA.symbol), symbolB: text(tokenB.symbol),
    nameA: text(tokenA.name), nameB: text(tokenB.name),
    decimalsA: num(tokenA.decimals) ?? 0, decimalsB: num(tokenB.decimals) ?? 0,
    programA: text(tokenA.programId), programB: text(tokenB.programId),
    tagsA: tags(tokenA.tags), tagsB: tags(tokenB.tags),
    tickSpacing,
    feeRate: feeRateRaw / 1_000_000,
    feeTierBps: feeRateRaw / 100,
    protocolFeeShare,
    adaptiveFeeEnabled: pool.adaptiveFeeEnabled === true,
    price: num(pool.price),
    tvlUsd: num(pool.tvlUsdc),
    volume24hUsd: num(day.volume),
    fees24hUsd,
    lpFees24hUsd: fees24hUsd === null ? null : fees24hUsd * (1 - protocolFeeShare),
    volume7dUsd: num(week.volume),
    fees7dUsd: num(week.fees),
    updatedAt: text(pool.updatedAt) || null,
  };
}

export type FetchOrcaPoolsOptions = {
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  /** Defaults to every allowlisted pool. */
  poolAddresses?: readonly string[];
  apiBase?: string;
};

/**
 * Fetch allowlisted Orca pools one by one (the allowlist is tiny). A pool whose
 * request fails or that fails the gate is skipped, never guessed.
 */
export async function fetchOrcaPools(options: FetchOrcaPoolsOptions = {}): Promise<OrcaPoolSummary[]> {
  const fetcher = options.fetcher ?? fetch;
  const base = options.apiBase ?? ORCA_API_V2;
  const ids = (options.poolAddresses ?? ORCA_ALLOWLISTED_POOLS.map(spec => spec.poolAddress)).filter(id => ALLOWLIST_BY_ID.has(id));
  const results = await Promise.all(ids.map(async id => {
    try {
      const response = await fetcher(`${base}/pools/${encodeURIComponent(id)}`, { headers: { accept: "application/json" }, signal: options.signal });
      if (!response.ok) return null;
      const body = record(await response.json());
      const summary = parseOrcaPool(body?.data);
      return summary?.poolAddress === id ? summary : null;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      return null;
    }
  }));
  return results.filter((summary): summary is OrcaPoolSummary => summary !== null);
}

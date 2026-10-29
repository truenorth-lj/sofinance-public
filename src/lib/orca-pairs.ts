import "server-only";

import type { Connection } from "@solana/web3.js";
import { rpcConnection } from "@sofinance/engine/rpc";
import { fetchOrcaPools, type FetchOrcaPoolsOptions, type OrcaPoolSummary } from "@sofinance/engine/protocols/orca/discovery";
import { estimateFeeAprPct, FEE_APR_ESTIMATE_LABEL, hasFreezeTag, isToken2022Program } from "./rwa-pairing";
import { readMintFreezeAuthorities } from "./onchain-mint-freeze";
import type { RwaPairRow } from "./rwa-pairs";

/** Read-only Orca rows in the `/api/rwa-pairs` row shape (protocol "orca-whirlpool"). */
export function orcaPairRow(pool: OrcaPoolSummary, onchainFreeze: ReadonlyMap<string, boolean> = new Map()): RwaPairRow {
  const { spec } = pool;
  // Display order follows the allowlist (wrapped first), like Raydium allowlisted pools.
  // Freeze risk: the mint's on-chain freeze authority; Orca's API tags only when the chain read failed.
  const freezeRiskA = onchainFreeze.get(pool.mintA) ?? hasFreezeTag(pool.tagsA);
  const freezeRiskB = onchainFreeze.get(pool.mintB) ?? hasFreezeTag(pool.tagsB);
  return {
    poolAddress: pool.poolAddress,
    protocol: "orca-whirlpool",
    mintA: pool.mintA,
    mintB: pool.mintB,
    symbolA: pool.symbolA || (pool.mintA === spec.mintA ? spec.wrappedSymbol : spec.plainSymbol),
    symbolB: pool.symbolB || (pool.mintB === spec.mintB ? spec.plainSymbol : spec.wrappedSymbol),
    nameA: pool.nameA,
    nameB: pool.nameB,
    baseSymbol: spec.baseSymbol,
    wrappedSymbol: spec.wrappedSymbol,
    plainSymbol: spec.plainSymbol,
    wrapKind: "same-asset",
    relatedness: "allowlisted",
    qualificationA: "allowlist",
    qualificationB: "allowlist",
    preferredTags: false,
    jupiterTagsA: [],
    jupiterTagsB: [],
    feeRate: pool.feeRate,
    feeTierBps: pool.feeTierBps,
    tvlUsd: pool.tvlUsd,
    volume24hUsd: pool.volume24hUsd,
    // LP share (Orca keeps protocolFeeRate of every swap fee).
    fees24hUsd: pool.lpFees24hUsd,
    raydiumFeeApr24h: null,
    estimatedFeeAprPct: pool.tvlUsd !== null && pool.lpFees24hUsd !== null ? estimateFeeAprPct(pool.lpFees24hUsd, pool.tvlUsd) : null,
    estimatedFeeAprLabel: FEE_APR_ESTIMATE_LABEL,
    token2022A: isToken2022Program(pool.programA),
    token2022B: isToken2022Program(pool.programB),
    freezeRiskA,
    freezeRiskB,
    freezeRisk: freezeRiskA || freezeRiskB,
  };
}

export type OrcaPairsResult = {
  protocol: "orca-whirlpool";
  readOnly: true;
  pairs: RwaPairRow[];
  fetchedAt: string;
  source: string;
  /** Where freeze risk came from: the mints on chain, or Orca's API tags when the chain read failed. */
  freezeAuthoritySource: "onchain" | "api-tags";
};

const CACHE_TTL_MS = 60_000;
let cache: { at: number; result: OrcaPairsResult } | null = null;

export async function discoverOrcaPairs(
  options: FetchOrcaPoolsOptions & { bypassCache?: boolean; connection?: Connection } = {},
): Promise<OrcaPairsResult> {
  if (!options.bypassCache && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.result;
  const pools = await fetchOrcaPools(options);
  const mints = pools.flatMap((pool) => [pool.mintA, pool.mintB]);
  let freeze = new Map<string, boolean>();
  try {
    if (mints.length > 0) freeze = await readMintFreezeAuthorities(options.connection ?? rpcConnection(), mints);
  } catch { /* RPC down: fall back to API tags */ }
  const onchain = mints.every((mint) => freeze.has(mint));
  const result: OrcaPairsResult = {
    protocol: "orca-whirlpool",
    readOnly: true,
    pairs: pools.map((pool) => orcaPairRow(pool, freeze)),
    fetchedAt: new Date().toISOString(),
    source: "https://api.orca.so/v2/solana/pools/{address} (allowlist: cbBTC/WBTC); Solana RPC: mint freeze authority",
    freezeAuthoritySource: onchain ? "onchain" : "api-tags",
  };
  if (!options.bypassCache) cache = { at: Date.now(), result };
  return result;
}

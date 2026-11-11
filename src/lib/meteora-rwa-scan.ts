import "@/lib/engine-host";
import "server-only";

import type { Connection } from "@solana/web3.js";
import { METEORA_DLMM_DATAPI, METEORA_RANGE_APR_MAX_BIN_STEP, type MeteoraPoolSpec } from "@sofinance/engine/protocols/meteora/constants";
import {
  fetchMeteoraPoolsByMint, fetchMeteoraPoolsByQuery, parseMeteoraPool, parseMeteoraScanPool, type MeteoraPoolSummary,
} from "@sofinance/engine/protocols/meteora/discovery";
import { rpcConnection } from "@sofinance/engine/rpc";
import { withTimeout } from "@sofinance/engine/async";
import { meteoraPairRow, readMeteoraOnchainFacts, type MeteoraOnchainFacts, type MeteoraRowIdentity } from "./meteora-pairs";
import { matchSameAssetPair, solanaStaticToken } from "./pool-metrics/solana-registry";
import { pairRegistryTokens } from "./pool-metrics/token-registry";
import { FEE_APR_ESTIMATE_LABEL, matchWrapPairShape, PAIRING_RULE_SUMMARY } from "./rwa-pairing";
import { fetchJupiterTagsByMint, getJupiterTagsObservedAt } from "./rwa-jupiter-tags";
import { applyOnchainFreezeRisk, sortPairs, type DiscoverRwaPairsResult, type RwaPairSortBy } from "./rwa-pairs";
import { fetchXstocksSolanaMintSet, getXstocksObservedAt } from "./rwa-xstocks-whitelist";

/**
 * Meteora DLMM side of the RWA pool scan (SCAN_DESIGN.md §6): the same pairing rule as Raydium, applied to the
 * pools Meteora's datapi lists for each seed mint.
 *
 * 1. Candidates: every pool datapi's text search returns for `xStock` (all pools with a Backed xStocks token, one
 *    request; the xStocks list has ~1,400 Solana mints, too many to ask one by one), plus one list query per side for
 *    each other mint of the Raydium feed (`token_x` / `token_y`, `is_blacklisted=false`), 5 at a time. USDC / USDT
 *    are never seeds: a stablecoin pool is listed only from `METEORA_ALLOWLISTED_STABLE_POOLS` (Raydium's rule).
 * 2. Any query failing fails the scan (nothing is published).
 * 3. FOOx/FOO ticker shape, then Jupiter `stocks`/`rwa` tags or the xStocks list on both mints
 *    (`matchSameAssetPair`): same underlying, different issuer. No other pairs (no SOL / USDC quote pools).
 * 4. Bin step ≤ 10 (`METEORA_RANGE_APR_MAX_BIN_STEP`); wider ones are counted in the summary, not listed.
 * 5. On-chain: LbPair protocol share and token programs, mint freeze authority and the Token-2022 block.
 */

/** Curated Meteora stablecoin pools (USDC / USDT). Empty: none is listed (product decision, SCAN_DESIGN.md §12.1). */
export const METEORA_ALLOWLISTED_STABLE_POOLS: readonly MeteoraPoolSpec[] = Object.freeze([]);

const QUERY_CONCURRENCY = 5;
/** datapi text search that returns every pool with a Backed xStocks token (token names end in "xStock"). */
export const METEORA_XSTOCKS_QUERY = "xStock";
const FACTS_TIMEOUT_MS = 8_000;

export type MeteoraScanStats = {
  /** Non-xStocks seed mints asked by mint (Raydium feed mints). */
  seedMints: number;
  /** datapi list queries (the `xStock` search plus two per seed mint). */
  queries: number;
  /** Pools the `xStock` search returned. */
  xstocksQueryPools: number;
  /** Distinct pools the queries returned (not blacklisted). */
  scannedPools: number;
  /** FOOx/FOO ticker shape. */
  shapeCandidates: number;
  /** Through the full pairing rule (any bin step, any TVL). */
  sameAssetPools: number;
  /** Same-asset pools left out because their bin step is above 10. */
  excludedBinStep: number;
  /** Seeds whose pool count hit the page cap (results cut off). */
  truncatedSeeds: number;
  /** LbPair read: pools verified on chain / read failed or mismatched (datapi values kept). */
  onchainVerified: number;
  blocked: number;
};

export type DiscoverMeteoraRwaOptions = {
  minTvl?: number;
  sortBy?: RwaPairSortBy;
  /** Extra seed mints (the Raydium feed's). */
  seedMints?: readonly string[];
  stablePools?: readonly MeteoraPoolSpec[];
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  bypassCache?: boolean;
  jupiterApiKey?: string | undefined;
  /** Solana RPC for the on-chain reads; `null` skips them (tests). */
  connection?: Connection | null;
  apiBase?: string;
};

export type DiscoverMeteoraRwaResult = DiscoverRwaPairsResult & { meteora: MeteoraScanStats };

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  }));
  return out;
}

/** Store pages: the datapi list has none, so the scanned count is split into ≤1000-pool chunks (`pageCounts`). */
export function scanPageCounts(scannedPools: number): number[] {
  if (scannedPools === 0) return [0];
  const counts: number[] = [];
  for (let left = scannedPools; left > 0; left -= 1000) counts.push(Math.min(1000, left));
  return counts;
}

/** TVL floor for the published Meteora feed (SCAN_DESIGN.md §12 Q8: the site's $5k), so dust pools never reach the APR lane. */
export const METEORA_SCAN_MIN_TVL_USD = 5_000;

/**
 * Discover the Meteora DLMM RWA pools (rows in the `rwa-pairs` shape, protocol `meteora-dlmm`). Throws when any
 * datapi query fails, so a partial scan is never published (the feed keeps its last generation).
 */
export async function discoverMeteoraRwaPairs(options: DiscoverMeteoraRwaOptions = {}): Promise<DiscoverMeteoraRwaResult> {
  const fetcher = options.fetcher ?? fetch;
  const apiBase = options.apiBase ?? METEORA_DLMM_DATAPI;
  const xstocks = await fetchXstocksSolanaMintSet({ fetcher, bypassCache: options.bypassCache, signal: options.signal });
  // xStocks mints are covered by the `xStock` search; the other seeds are asked by mint.
  const seeds = [...new Set(options.seedMints ?? [])].filter((mint) => !solanaStaticToken(mint) && !xstocks.has(mint)).sort();
  const queries = seeds.flatMap((mint) => (["token_x", "token_y"] as const).map((side) => ({ mint, side })));
  const xstockList = await fetchMeteoraPoolsByQuery(METEORA_XSTOCKS_QUERY, { fetcher, signal: options.signal, apiBase });
  const mintLists = await mapLimit(queries, QUERY_CONCURRENCY, ({ mint, side }) =>
    fetchMeteoraPoolsByMint(mint, side, { fetcher, signal: options.signal, apiBase }));
  const lists = [xstockList, ...mintLists];
  options.signal?.throwIfAborted();
  const observedAt = new Date().toISOString();
  const raw = new Map<string, unknown>();
  for (const list of lists) for (const pool of list.pools) {
    const address = (pool as { address?: unknown })?.address;
    if (typeof address === "string" && !raw.has(address)) raw.set(address, pool);
  }

  // Ticker shape first (cheap), then the Jupiter tag lookup for just those mints.
  const shaped = [...raw.values()].map(parseMeteoraScanPool)
    .filter((pool): pool is MeteoraPoolSummary<MeteoraPoolSpec> => !!pool && matchWrapPairShape(pool.symbolX, pool.symbolY).matched);
  const mints = [...new Set(shaped.flatMap((pool) => [pool.mintX, pool.mintY]))];
  const jupiterTags = await fetchJupiterTagsByMint(mints, { fetcher, apiKey: options.jupiterApiKey, signal: options.signal, bypassCache: options.bypassCache });
  const matched: { pool: MeteoraPoolSummary<MeteoraPoolSpec>; identity: MeteoraRowIdentity }[] = [];
  let sameAssetPools = 0, excludedBinStep = 0;
  for (const pool of shaped) {
    const tagsX = jupiterTags.get(pool.mintX) ?? [], tagsY = jupiterTags.get(pool.mintY) ?? [];
    const match = matchSameAssetPair(
      { address: pool.mintX, symbol: pool.symbolX, name: pool.nameX, jupiterTags: tagsX, onXstocksWhitelist: xstocks.has(pool.mintX) },
      { address: pool.mintY, symbol: pool.symbolY, name: pool.nameY, jupiterTags: tagsY, onXstocksWhitelist: xstocks.has(pool.mintY) },
    );
    if (!match.matched) continue;
    sameAssetPools += 1;
    if (pool.binStep > METEORA_RANGE_APR_MAX_BIN_STEP) { excludedBinStep += 1; continue; }
    if ((pool.tvlUsd ?? 0) < (options.minTvl ?? 0)) continue;
    matched.push({ pool, identity: {
      baseSymbol: match.baseSymbol, wrappedSymbol: match.wrappedSymbol, plainSymbol: match.plainSymbol, wrapKind: match.wrapKind,
      relatedness: match.relatedness, qualificationA: match.qualificationA, qualificationB: match.qualificationB,
      preferredTags: match.preferredTags, jupiterTagsA: tagsX, jupiterTagsB: tagsY,
    } });
  }
  const stable = await stablePoolRows(options.stablePools ?? METEORA_ALLOWLISTED_STABLE_POOLS, fetcher, apiBase, options.signal);
  for (const entry of stable) if (!matched.some((m) => m.pool.poolAddress === entry.pool.poolAddress)) matched.push(entry);

  // On-chain facts (best effort, like Raydium's freeze read): protocol share, token programs, freeze authority.
  let facts: MeteoraOnchainFacts = { protocolShareBps: new Map(), freezeAuthority: new Map() };
  const connection = options.connection === null ? null : options.connection ?? rpcConnection();
  if (connection && matched.length) {
    try { facts = await withTimeout(readMeteoraOnchainFacts(connection, matched.map((m) => m.pool)), FACTS_TIMEOUT_MS); } catch { /* datapi values */ }
  }
  const rows = matched.map(({ pool, identity }) => meteoraPairRow(pool, facts, identity));
  const freeze = await applyOnchainFreezeRisk(rows, connection);
  const pairs = sortPairs(freeze.pairs, options.sortBy ?? "estimatedFeeApr");
  const pageCounts = scanPageCounts(raw.size);
  return {
    pairs,
    scannedPools: raw.size,
    pagesFetched: pageCounts.length,
    fetchedAt: observedAt,
    pairingRuleSummary: PAIRING_RULE_SUMMARY,
    estimatedFeeAprLabel: FEE_APR_ESTIMATE_LABEL,
    source: `${apiBase}/pools?query=xStock + ?filter_by=token_x|token_y=<mint> (other Raydium feed mints) + Jupiter tokens/v2/search tags + xStocks whitelist; Solana RPC: LbPair, mint freeze authority`,
    freezeRiskSource: freeze.source,
    discovery: {
      sourcePages: Object.fromEntries(pairs.map((pair) => [pair.poolAddress, 1])),
      poolObservedAt: Object.fromEntries(pairs.map((pair) => [pair.poolAddress, observedAt])),
      pageCounts,
      qualificationObservedAt: { jupiter: getJupiterTagsObservedAt(mints), xstocks: getXstocksObservedAt() },
    },
    meteora: {
      seedMints: seeds.length, queries: queries.length + 1, xstocksQueryPools: xstockList.pools.length, scannedPools: raw.size, shapeCandidates: shaped.length, sameAssetPools,
      excludedBinStep, truncatedSeeds: lists.filter((list) => list.truncated).length,
      onchainVerified: facts.protocolShareBps.size, blocked: pairs.filter((pair) => pair.blocked).length,
    },
  };
}

/** Curated stablecoin pools: fetched by id, kept only when both mints are the curated USDC / USDT tokens. */
async function stablePoolRows(specs: readonly MeteoraPoolSpec[], fetcher: typeof fetch, apiBase: string, signal?: AbortSignal) {
  const rows: { pool: MeteoraPoolSummary<MeteoraPoolSpec>; identity: MeteoraRowIdentity }[] = [];
  for (const spec of specs) {
    const response = await fetcher(`${apiBase}/pools/${encodeURIComponent(spec.poolAddress)}`, { headers: { accept: "application/json" }, signal });
    if (!response.ok) continue;
    const pool = parseMeteoraPool(await response.json(), spec) as MeteoraPoolSummary<MeteoraPoolSpec> | null;
    const tokenX = solanaStaticToken(spec.mintX), tokenY = solanaStaticToken(spec.mintY);
    if (!pool || !tokenX || !tokenY || !pairRegistryTokens([tokenX], [tokenY]) || pool.binStep > METEORA_RANGE_APR_MAX_BIN_STEP) continue;
    rows.push({ pool, identity: { baseSymbol: tokenX.underlying, wrappedSymbol: tokenX.symbol, plainSymbol: tokenY.symbol, wrapKind: "stable",
      relatedness: "allowlisted", qualificationA: "allowlist", qualificationB: "allowlist", preferredTags: false, jupiterTagsA: [], jupiterTagsB: [] } });
  }
  return rows;
}

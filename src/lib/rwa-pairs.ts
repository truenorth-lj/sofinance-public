import "server-only";

import {
  estimateFeeAprPct,
  FEE_APR_ESTIMATE_LABEL,
  hasFreezeTag,
  isToken2022Program,
  matchSameAssetPair,
  matchWrapPairShape,
  PAIRING_RULE_SUMMARY,
  type PairingMatch,
  type Relatedness,
  type RwaQualificationSource,
} from "./rwa-pairing";
import { fetchJupiterTagsByMint } from "./rwa-jupiter-tags";
import { fetchXstocksSolanaMintSet } from "./rwa-xstocks-whitelist";

export const RAYDIUM_API_V3 = "https://api-v3.raydium.io";
const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_MAX_PAGES = 10;
const CACHE_TTL_MS = 90_000;

export type RwaPairSortBy = "estimatedFeeApr" | "tvl" | "volume24h";

export type DiscoverRwaPairsOptions = {
  /** Minimum TVL in USD (default 0). */
  minTvl?: number;
  /** Max Raydium list pages to scan (1–30, default 10 ≈ up to 10k CLMM pools). */
  maxPages?: number;
  sortBy?: RwaPairSortBy;
  /** Injected fetch for tests. */
  fetcher?: typeof fetch;
  /** Skip in-memory caches (tests). */
  bypassCache?: boolean;
  /** Override Jupiter API key (tests). Defaults to process.env.JUPITER_API_KEY. */
  jupiterApiKey?: string | undefined;
};

export type RwaPairRow = {
  poolAddress: string;
  mintA: string;
  mintB: string;
  symbolA: string;
  symbolB: string;
  nameA: string;
  nameB: string;
  baseSymbol: string;
  wrappedSymbol: string;
  plainSymbol: string;
  wrapKind: PairingMatch["wrapKind"];
  relatedness: Relatedness;
  qualificationA: RwaQualificationSource;
  qualificationB: RwaQualificationSource;
  preferredTags: boolean;
  jupiterTagsA: string[];
  jupiterTagsB: string[];
  feeRate: number | null;
  feeTierBps: number | null;
  tvlUsd: number | null;
  volume24hUsd: number | null;
  fees24hUsd: number | null;
  /** Raydium-published day.feeApr when present. */
  raydiumFeeApr24h: number | null;
  /**
   * Estimated annualized fee APR from (fees24h / tvl) * 365 * 100.
   * See estimatedFeeAprLabel.
   */
  estimatedFeeAprPct: number | null;
  estimatedFeeAprLabel: string;
  token2022A: boolean;
  token2022B: boolean;
  freezeRiskA: boolean;
  freezeRiskB: boolean;
  freezeRisk: boolean;
};

export type DiscoverRwaPairsResult = {
  pairs: RwaPairRow[];
  scannedPools: number;
  pagesFetched: number;
  fetchedAt: string;
  pairingRuleSummary: string;
  estimatedFeeAprLabel: string;
  source: string;
};

type RaydiumMint = {
  address?: unknown;
  symbol?: unknown;
  name?: unknown;
  programId?: unknown;
  tags?: unknown;
  extensions?: unknown;
};

type RaydiumPool = {
  id?: unknown;
  type?: unknown;
  feeRate?: unknown;
  tvl?: unknown;
  mintA?: RaydiumMint;
  mintB?: RaydiumMint;
  day?: {
    volume?: unknown;
    volumeFee?: unknown;
    feeApr?: unknown;
    apr?: unknown;
  };
};

type CacheEntry = { expiresAt: number; key: string; value: DiscoverRwaPairsResult };
let cache: CacheEntry | null = null;

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function mintTags(tags: unknown): string[] {
  return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [];
}

export type MintQualifierLookup = {
  jupiterTagsByMint: Map<string, string[]>;
  xstocksMints: Set<string>;
};

type StructuralCandidate = {
  pool: RaydiumPool;
  poolAddress: string;
  addressA: string;
  addressB: string;
  symbolA: string;
  symbolB: string;
  nameA: string;
  nameB: string;
};

/**
 * Structural FOOx/FOO gate only (no Jupiter / whitelist yet).
 * Used to collect candidate pools before mint qualification lookups.
 */
export function isStructuralWrapPairCandidate(raw: unknown): StructuralCandidate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const pool = raw as RaydiumPool;
  const poolAddress = asString(pool.id);
  const mintA = pool.mintA || {};
  const mintB = pool.mintB || {};
  const addressA = asString(mintA.address);
  const addressB = asString(mintB.address);
  const symbolA = asString(mintA.symbol);
  const symbolB = asString(mintB.symbol);
  if (!poolAddress || !addressA || !addressB || !symbolA || !symbolB) return null;

  const shape = matchWrapPairShape(symbolA, symbolB);
  if (!shape.matched) return null;

  return {
    pool,
    poolAddress,
    addressA,
    addressB,
    symbolA,
    symbolB,
    nameA: asString(mintA.name),
    nameB: asString(mintB.name),
  };
}

/** Build an RWA pair row when structural + Jupiter/xStocks qualification both pass. */
export function parseRaydiumPoolAsRwaPair(
  raw: unknown,
  qualifiers?: MintQualifierLookup,
): RwaPairRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const pool = raw as RaydiumPool;
  const poolAddress = asString(pool.id);
  const mintA = pool.mintA || {};
  const mintB = pool.mintB || {};
  const addressA = asString(mintA.address);
  const addressB = asString(mintB.address);
  const symbolA = asString(mintA.symbol);
  const symbolB = asString(mintB.symbol);
  if (!poolAddress || !addressA || !addressB || !symbolA || !symbolB) return null;

  const jupiterTagsA = qualifiers?.jupiterTagsByMint.get(addressA) ?? [];
  const jupiterTagsB = qualifiers?.jupiterTagsByMint.get(addressB) ?? [];
  const onWhitelistA = qualifiers?.xstocksMints.has(addressA) ?? false;
  const onWhitelistB = qualifiers?.xstocksMints.has(addressB) ?? false;

  // When no qualifier lookup is supplied (unit tests), require explicit tags on the call
  // site via a synthetic qualifier map — empty lookup means unqualified.
  const match = matchSameAssetPair(
    {
      symbol: symbolA,
      name: asString(mintA.name),
      jupiterTags: jupiterTagsA,
      onXstocksWhitelist: onWhitelistA,
    },
    {
      symbol: symbolB,
      name: asString(mintB.name),
      jupiterTags: jupiterTagsB,
      onXstocksWhitelist: onWhitelistB,
    },
  );
  if (!match.matched) return null;

  const tvlUsd = asNumber(pool.tvl);
  const volume24hUsd = asNumber(pool.day?.volume);
  const fees24hUsd = asNumber(pool.day?.volumeFee);
  const raydiumFeeApr24h = asNumber(pool.day?.feeApr);
  const feeRate = asNumber(pool.feeRate);
  const feeTierBps = feeRate === null ? null : Math.round(feeRate * 10_000 * 100) / 100;
  const estimatedFeeAprPct =
    tvlUsd !== null && fees24hUsd !== null ? estimateFeeAprPct(fees24hUsd, tvlUsd) : null;

  const token2022A = isToken2022Program(asString(mintA.programId));
  const token2022B = isToken2022Program(asString(mintB.programId));
  const freezeRiskA = hasFreezeTag(mintTags(mintA.tags));
  const freezeRiskB = hasFreezeTag(mintTags(mintB.tags));

  return {
    poolAddress,
    mintA: addressA,
    mintB: addressB,
    symbolA,
    symbolB,
    nameA: asString(mintA.name),
    nameB: asString(mintB.name),
    baseSymbol: match.baseSymbol,
    wrappedSymbol: match.wrappedSymbol,
    plainSymbol: match.plainSymbol,
    wrapKind: match.wrapKind,
    relatedness: match.relatedness,
    qualificationA: match.qualificationA,
    qualificationB: match.qualificationB,
    preferredTags: match.preferredTags,
    jupiterTagsA,
    jupiterTagsB,
    feeRate,
    feeTierBps,
    tvlUsd,
    volume24hUsd,
    fees24hUsd,
    raydiumFeeApr24h,
    estimatedFeeAprPct,
    estimatedFeeAprLabel: FEE_APR_ESTIMATE_LABEL,
    token2022A,
    token2022B,
    freezeRiskA,
    freezeRiskB,
    freezeRisk: freezeRiskA || freezeRiskB,
  };
}

async function fetchClmmPage(
  page: number,
  pageSize: number,
  fetcher: typeof fetch,
): Promise<{ rows: unknown[]; hasNextPage: boolean }> {
  const url = new URL(`${RAYDIUM_API_V3}/pools/info/list`);
  url.searchParams.set("poolType", "concentrated");
  url.searchParams.set("poolSortField", "liquidity");
  url.searchParams.set("sortType", "desc");
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("page", String(page));

  const response = await fetcher(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "SoFinance/0.1 (RWA pair discovery; +https://github.com/truenorth-lj/sofinance-public)",
    },
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) {
    throw new Error(`Raydium pool list failed (${response.status})`);
  }
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Raydium pool list returned unexpected payload");
  }
  const envelope = body as { success?: unknown; data?: unknown };
  if (envelope.success === false) {
    throw new Error("Raydium pool list reported failure");
  }
  const data = envelope.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Raydium pool list missing data");
  }
  const pageData = data as { data?: unknown; hasNextPage?: unknown };
  const rows = Array.isArray(pageData.data) ? pageData.data : [];
  return { rows, hasNextPage: pageData.hasNextPage === true };
}

function sortPairs(pairs: RwaPairRow[], sortBy: RwaPairSortBy): RwaPairRow[] {
  const score = (row: RwaPairRow) => {
    if (sortBy === "tvl") return row.tvlUsd ?? -1;
    if (sortBy === "volume24h") return row.volume24hUsd ?? -1;
    // Prefer estimated APR; fall back to Raydium-published fee APR.
    return row.estimatedFeeAprPct ?? row.raydiumFeeApr24h ?? -1;
  };
  return [...pairs].sort((a, b) => {
    // Prefer pools with xstocks/backpack tags when APR ties.
    const pref = Number(b.preferredTags) - Number(a.preferredTags);
    const diff = score(b) - score(a);
    if (diff !== 0) return diff;
    if (pref !== 0) return pref;
    return (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0);
  });
}

/**
 * Discover Raydium CLMM pools where both sides are the same underlying RWA
 * (wrapped vs unwrapped / xStock style). Uses Raydium API v3 list, Jupiter
 * Tokens API tags (primary), and Backed xStocks whitelist (secondary).
 */
export async function discoverRwaPairs(
  options: DiscoverRwaPairsOptions = {},
): Promise<DiscoverRwaPairsResult> {
  const minTvl = options.minTvl ?? 0;
  const maxPages = Math.min(30, Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES));
  const sortBy = options.sortBy ?? "estimatedFeeApr";
  const fetcher = options.fetcher ?? fetch;
  const cacheKey = `${minTvl}|${maxPages}|${sortBy}`;

  if (!options.bypassCache && cache && cache.key === cacheKey && cache.expiresAt > Date.now()) {
    return cache.value;
  }

  const structuralRows: unknown[] = [];
  let scannedPools = 0;
  let pagesFetched = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    const { rows, hasNextPage } = await fetchClmmPage(page, DEFAULT_PAGE_SIZE, fetcher);
    pagesFetched += 1;
    scannedPools += rows.length;
    for (const row of rows) {
      if (isStructuralWrapPairCandidate(row)) structuralRows.push(row);
    }
    if (!hasNextPage || rows.length === 0) break;
  }

  const mintSet = new Set<string>();
  for (const row of structuralRows) {
    const candidate = isStructuralWrapPairCandidate(row);
    if (!candidate) continue;
    mintSet.add(candidate.addressA);
    mintSet.add(candidate.addressB);
  }
  const mints = [...mintSet];

  const [jupiterTagsByMint, xstocksMints] = await Promise.all([
    fetchJupiterTagsByMint(mints, {
      fetcher,
      apiKey: options.jupiterApiKey,
      bypassCache: options.bypassCache,
    }),
    fetchXstocksSolanaMintSet({ fetcher, bypassCache: options.bypassCache }),
  ]);

  const qualifiers: MintQualifierLookup = { jupiterTagsByMint, xstocksMints };
  const pairs: RwaPairRow[] = [];
  for (const row of structuralRows) {
    const parsed = parseRaydiumPoolAsRwaPair(row, qualifiers);
    if (!parsed) continue;
    if ((parsed.tvlUsd ?? 0) < minTvl) continue;
    pairs.push(parsed);
  }

  const result: DiscoverRwaPairsResult = {
    pairs: sortPairs(pairs, sortBy),
    scannedPools,
    pagesFetched,
    fetchedAt: new Date().toISOString(),
    pairingRuleSummary: PAIRING_RULE_SUMMARY,
    estimatedFeeAprLabel: FEE_APR_ESTIMATE_LABEL,
    source: `${RAYDIUM_API_V3}/pools/info/list?poolType=concentrated + Jupiter tokens/v2/search tags + xStocks whitelist`,
  };

  cache = { key: cacheKey, expiresAt: Date.now() + CACHE_TTL_MS, value: result };
  return result;
}

/** Test helper to clear the module cache. */
export function clearRwaPairsCache() {
  cache = null;
}

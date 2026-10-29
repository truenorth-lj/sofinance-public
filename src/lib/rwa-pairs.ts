import "server-only";

import {
  allowlistedPoolById,
  mintsMatchAllowlist,
  missingAllowlistedPoolIds,
} from "./rwa-allowlist";
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
import { DEFAULT_PROTOCOL, type ProtocolId } from "@sofinance/engine/protocols/types";
import { fetchJupiterTagsByMint, getJupiterTagsObservedAt } from "./rwa-jupiter-tags";
import { fetchXstocksSolanaMintSet, getXstocksObservedAt } from "./rwa-xstocks-whitelist";

export const RAYDIUM_API_V3 = "https://api-v3.raydium.io";
const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_MAX_PAGES = 10;
const STALE_THRESHOLD_MS = 3_600_000; // 1 hour

export type RwaPairSortBy = "estimatedFeeApr" | "tvl" | "volume24h";

export type DiscoverRwaPairsOptions = {
  /** Minimum TVL in USD (default 0). */
  minTvl?: number;
  /** Max Raydium list pages to scan (1–30, default 10 ≈ up to 10k CLMM pools). */
  maxPages?: number;
  sortBy?: RwaPairSortBy;
  /** Injected fetch for tests. */
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  /** Skip in-memory caches (tests). */
  bypassCache?: boolean;
  /** Override Jupiter API key (tests). Defaults to process.env.JUPITER_API_KEY. */
  jupiterApiKey?: string | undefined;
};

export type RwaPairRow = {
  poolAddress: string;
  /** Concentrated-liquidity protocol that owns the pool. */
  protocol: ProtocolId;
  mintA: string;
  mintB: string;
  symbolA: string;
  symbolB: string;
  nameA: string;
  nameB: string;
  baseSymbol: string;
  wrappedSymbol: string;
  plainSymbol: string;
  wrapKind: PairingMatch["wrapKind"] | "stable";
  relatedness: Relatedness | "allowlisted";
  qualificationA: RwaQualificationSource | "allowlist";
  qualificationB: RwaQualificationSource | "allowlist";
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
  /** ISO timestamp when this result was originally cached. */
  cachedAt?: string;
  /** True if this result is stale (age > 1 hour) and a background refresh was triggered. */
  stale?: boolean;
  /** Age of the cached result in seconds. */
  ageSeconds?: number;
  discovery?: { sourcePages: Record<string, number>; poolObservedAt: Record<string, string>; pageCounts: number[]; qualificationObservedAt: Record<string, string | null> };
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

type CacheEntry = {
  key: string;
  value: DiscoverRwaPairsResult;
  createdAt: number;
};
let cache: CacheEntry | null = null;

/** Track in-flight refreshes to prevent stampedes (key -> Promise). */
const refreshLocks = new Map<string, Promise<DiscoverRwaPairsResult>>();

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

function readPoolMints(raw: unknown): StructuralCandidate | null {
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

/**
 * Structural FOOx/FOO gate only (no Jupiter / whitelist yet).
 * Used to collect candidate pools before mint qualification lookups.
 */
export function isStructuralWrapPairCandidate(raw: unknown): StructuralCandidate | null {
  const candidate = readPoolMints(raw);
  if (!candidate) return null;
  const shape = matchWrapPairShape(candidate.symbolA, candidate.symbolB);
  if (!shape.matched) return null;
  return candidate;
}

/** Curated CLMM allowlist: exact pool id plus the expected mint pair. */
export function isAllowlistedPoolCandidate(raw: unknown): StructuralCandidate | null {
  const candidate = readPoolMints(raw);
  if (!candidate) return null;
  const spec = allowlistedPoolById(candidate.poolAddress);
  if (!spec || !mintsMatchAllowlist(spec, candidate.addressA, candidate.addressB)) return null;
  return candidate;
}

function pairRowFromCandidate(
  candidate: StructuralCandidate,
  identity: Pick<
    RwaPairRow,
    "baseSymbol" | "wrappedSymbol" | "plainSymbol" | "wrapKind" | "relatedness" | "qualificationA" | "qualificationB" | "preferredTags"
  >,
  qualifiers?: MintQualifierLookup,
): RwaPairRow {
  const { pool, poolAddress, addressA, addressB, symbolA, symbolB, nameA, nameB } = candidate;
  const tvlUsd = asNumber(pool.tvl);
  const volume24hUsd = asNumber(pool.day?.volume);
  const fees24hUsd = asNumber(pool.day?.volumeFee);
  const raydiumFeeApr24h = asNumber(pool.day?.feeApr);
  const feeRate = asNumber(pool.feeRate);
  const feeTierBps = feeRate === null ? null : Math.round(feeRate * 10_000 * 100) / 100;
  const estimatedFeeAprPct =
    tvlUsd !== null && fees24hUsd !== null ? estimateFeeAprPct(fees24hUsd, tvlUsd) : null;
  const token2022A = isToken2022Program(asString((pool.mintA || {}).programId));
  const token2022B = isToken2022Program(asString((pool.mintB || {}).programId));
  const freezeRiskA = hasFreezeTag(mintTags((pool.mintA || {}).tags));
  const freezeRiskB = hasFreezeTag(mintTags((pool.mintB || {}).tags));
  return {
    poolAddress,
    protocol: DEFAULT_PROTOCOL,
    mintA: addressA,
    mintB: addressB,
    symbolA,
    symbolB,
    nameA,
    nameB,
    ...identity,
    jupiterTagsA: qualifiers?.jupiterTagsByMint.get(addressA) ?? [],
    jupiterTagsB: qualifiers?.jupiterTagsByMint.get(addressB) ?? [],
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

/** Build a pair row when the curated allowlist or wrap + Jupiter/xStocks qualification passes. */
export function parseRaydiumPoolAsRwaPair(
  raw: unknown,
  qualifiers?: MintQualifierLookup,
): RwaPairRow | null {
  const allowlisted = isAllowlistedPoolCandidate(raw);
  if (allowlisted) {
    const spec = allowlistedPoolById(allowlisted.poolAddress)!;
    return pairRowFromCandidate(
      allowlisted,
      {
        baseSymbol: spec.baseSymbol,
        wrappedSymbol: spec.wrappedSymbol,
        plainSymbol: spec.plainSymbol,
        wrapKind: "stable",
        relatedness: "allowlisted",
        qualificationA: "allowlist",
        qualificationB: "allowlist",
        preferredTags: false,
      },
      qualifiers,
    );
  }

  const candidate = readPoolMints(raw);
  if (!candidate) return null;

  const jupiterTagsA = qualifiers?.jupiterTagsByMint.get(candidate.addressA) ?? [];
  const jupiterTagsB = qualifiers?.jupiterTagsByMint.get(candidate.addressB) ?? [];
  const onWhitelistA = qualifiers?.xstocksMints.has(candidate.addressA) ?? false;
  const onWhitelistB = qualifiers?.xstocksMints.has(candidate.addressB) ?? false;

  // When no qualifier lookup is supplied (unit tests), require explicit tags on the call
  // site via a synthetic qualifier map — empty lookup means unqualified.
  const match = matchSameAssetPair(
    {
      symbol: candidate.symbolA,
      name: candidate.nameA,
      jupiterTags: jupiterTagsA,
      onXstocksWhitelist: onWhitelistA,
    },
    {
      symbol: candidate.symbolB,
      name: candidate.nameB,
      jupiterTags: jupiterTagsB,
      onXstocksWhitelist: onWhitelistB,
    },
  );
  if (!match.matched) return null;

  return pairRowFromCandidate(
    candidate,
    {
      baseSymbol: match.baseSymbol,
      wrappedSymbol: match.wrappedSymbol,
      plainSymbol: match.plainSymbol,
      wrapKind: match.wrapKind,
      relatedness: match.relatedness,
      qualificationA: match.qualificationA,
      qualificationB: match.qualificationB,
      preferredTags: match.preferredTags,
    },
    qualifiers,
  );
}

async function fetchClmmPage(
  page: number,
  pageSize: number,
  fetcher: typeof fetch,
  signal?: AbortSignal,
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
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
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

async function fetchClmmPoolsByIds(
  ids: string[],
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<unknown[]> {
  if (ids.length === 0) return [];
  const url = new URL(`${RAYDIUM_API_V3}/pools/info/ids`);
  url.searchParams.set("ids", ids.join(","));
  const response = await fetcher(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "SoFinance/0.1 (RWA pair discovery; +https://github.com/truenorth-lj/sofinance-public)",
    },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
  });
  if (!response.ok) {
    throw new Error(`Raydium pool ids failed (${response.status})`);
  }
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const envelope = body as { success?: unknown; data?: unknown };
  if (envelope.success === false || !Array.isArray(envelope.data)) return [];
  return envelope.data.filter((row) => row && typeof row === "object" && !Array.isArray(row));
}

export function sortPairs(pairs: RwaPairRow[], sortBy: RwaPairSortBy): RwaPairRow[] {
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
 * Check if a cached result exists for the given parameters.
 * Returns the cached result with metadata (age, stale flag) if available, or null.
 * 
 * This checks the in-memory cache within a single serverless instance.
 * Cross-instance caching is handled by CDN headers (Cache-Control) on the HTTP response.
 */
export function getCachedRwaPairs(
  minTvl: number,
  maxPages: number,
  sortBy: RwaPairSortBy,
): (DiscoverRwaPairsResult & { cacheHit: true }) | null {
  const cacheKey = `${minTvl}|${maxPages}|${sortBy}`;
  if (!cache || cache.key !== cacheKey) return null;

  const now = Date.now();
  const ageMs = now - cache.createdAt;
  const ageSeconds = Math.round(ageMs / 1000);
  const stale = ageMs > STALE_THRESHOLD_MS;

  return {
    ...cache.value,
    cachedAt: new Date(cache.createdAt).toISOString(),
    stale,
    ageSeconds,
    cacheHit: true,
  };
}

/**
 * Discover Raydium CLMM pools where both sides are the same underlying RWA
 * (wrapped vs unwrapped / xStock style), plus curated allowlisted CLMM pools
 * (USDC/USDT). Uses Raydium API v3 list, Jupiter Tokens API tags (primary),
 * Backed xStocks whitelist (secondary), and the curated pool-id allowlist.
 *
 * This function always performs a fresh discovery (no cache). For SWR behavior,
 * use getCachedRwaPairs first and only call this if you need fresh data.
 */
export async function discoverRwaPairs(
  options: DiscoverRwaPairsOptions = {},
): Promise<DiscoverRwaPairsResult> {
  const minTvl = options.minTvl ?? 0;
  const maxPages = Math.min(30, Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES));
  const sortBy = options.sortBy ?? "estimatedFeeApr";
  const fetcher = options.fetcher ?? fetch;
  const cacheKey = `${minTvl}|${maxPages}|${sortBy}`;

  // If bypassCache is false and we have an in-flight refresh for this key, wait for it
  if (!options.bypassCache && refreshLocks.has(cacheKey)) {
    return refreshLocks.get(cacheKey)!;
  }

  // Create a promise for this refresh and store it to prevent stampedes
  const refreshPromise = (async () => {
    try {
      const candidateRows: unknown[] = [];
      const sourcePages: Record<string,number> = {}, poolObservedAt: Record<string,string> = {};
      const pageCounts: number[] = [];
      let scannedPools = 0;
      let pagesFetched = 0;

      for (let page = 1; page <= maxPages; page += 1) {
        const { rows, hasNextPage } = await fetchClmmPage(page, DEFAULT_PAGE_SIZE, fetcher, options.signal);
        options.signal?.throwIfAborted();
        const observedAt = new Date().toISOString();
        pageCounts.push(rows.length);
        pagesFetched += 1;
        scannedPools += rows.length;
        for (const row of rows) {
          const candidate = isStructuralWrapPairCandidate(row) ?? isAllowlistedPoolCandidate(row);
          if (candidate) { candidateRows.push(row); sourcePages[candidate.poolAddress] = page; poolObservedAt[candidate.poolAddress] = observedAt; }
        }
        if (!hasNextPage || rows.length === 0) break;
      }

      const missingIds = missingAllowlistedPoolIds(Object.keys(sourcePages));
      if (missingIds.length) {
        try {
          const extras = await fetchClmmPoolsByIds(missingIds, fetcher, options.signal);
          const observedAt = new Date().toISOString();
          for (const row of extras) {
            const candidate = isAllowlistedPoolCandidate(row);
            if (!candidate || sourcePages[candidate.poolAddress]) continue;
            candidateRows.push(row);
            sourcePages[candidate.poolAddress] = 1;
            poolObservedAt[candidate.poolAddress] = observedAt;
          }
        } catch {
          // Scan remains the primary path; a failed ids lookup must not drop wrap pairs.
        }
      }

      const mintSet = new Set<string>();
      for (const row of candidateRows) {
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
          signal: options.signal,
          bypassCache: options.bypassCache,
        }),
        fetchXstocksSolanaMintSet({ fetcher, bypassCache: options.bypassCache, signal: options.signal }),
      ]);

      const qualifiers: MintQualifierLookup = { jupiterTagsByMint, xstocksMints };
      const pairs: RwaPairRow[] = [];
      const seen = new Set<string>();
      for (const row of candidateRows) {
        const parsed = parseRaydiumPoolAsRwaPair(row, qualifiers);
        if (!parsed || seen.has(parsed.poolAddress)) continue;
        if ((parsed.tvlUsd ?? 0) < minTvl) continue;
        seen.add(parsed.poolAddress);
        pairs.push(parsed);
      }

      const result: DiscoverRwaPairsResult = {
        pairs: sortPairs(pairs, sortBy),
        discovery: { sourcePages, poolObservedAt, pageCounts, qualificationObservedAt: { jupiter: getJupiterTagsObservedAt(mints), xstocks: getXstocksObservedAt() } },
        scannedPools,
        pagesFetched,
        fetchedAt: new Date().toISOString(),
        pairingRuleSummary: PAIRING_RULE_SUMMARY,
        estimatedFeeAprLabel: FEE_APR_ESTIMATE_LABEL,
        source: `${RAYDIUM_API_V3}/pools/info/list?poolType=concentrated + Jupiter tokens/v2/search tags + xStocks whitelist + curated CLMM allowlist`,
      };

      cache = { key: cacheKey, value: result, createdAt: Date.now() };
      return result;
    } finally {
      // Always clean up the lock when done
      refreshLocks.delete(cacheKey);
    }
  })();

  if (!options.bypassCache) {
    refreshLocks.set(cacheKey, refreshPromise);
  }

  return refreshPromise;
}

/** Test helper to clear the module cache. */
export function clearRwaPairsCache() {
  cache = null;
}

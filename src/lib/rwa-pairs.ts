import "server-only";

import {
  estimateFeeAprPct,
  FEE_APR_ESTIMATE_LABEL,
  hasFreezeTag,
  isToken2022Program,
  matchSameAssetPair,
  type PairingMatch,
} from "./rwa-pairing";

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
  /** Skip in-memory cache (tests). */
  bypassCache?: boolean;
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
  relatedness: PairingMatch["relatedness"];
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

const PAIRING_RULE_SUMMARY =
  "FOOx/FOO (or FOO-x / xFOO) symbol wrap + xStock/Backpack/tokenized naming evidence + related counterparty name; stables excluded.";

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

function extensionsToText(extensions: unknown): string {
  if (!extensions) return "";
  if (typeof extensions === "string") return extensions;
  try {
    return JSON.stringify(extensions);
  } catch {
    return "";
  }
}

function mintTags(tags: unknown): string[] {
  return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [];
}

/** Parse one Raydium list row into an RWA pair row, or null if not a match. */
export function parseRaydiumPoolAsRwaPair(raw: unknown): RwaPairRow | null {
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

  const match = matchSameAssetPair(
    { symbol: symbolA, name: asString(mintA.name), extensionsText: extensionsToText(mintA.extensions) },
    { symbol: symbolB, name: asString(mintB.name), extensionsText: extensionsToText(mintB.extensions) },
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
    const diff = score(b) - score(a);
    if (diff !== 0) return diff;
    return (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0);
  });
}

/**
 * Discover Raydium CLMM pools where both sides are the same underlying RWA
 * (wrapped vs unwrapped / xStock style). Uses the official Raydium API v3 list.
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

  const pairs: RwaPairRow[] = [];
  let scannedPools = 0;
  let pagesFetched = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    const { rows, hasNextPage } = await fetchClmmPage(page, DEFAULT_PAGE_SIZE, fetcher);
    pagesFetched += 1;
    scannedPools += rows.length;
    for (const row of rows) {
      const parsed = parseRaydiumPoolAsRwaPair(row);
      if (!parsed) continue;
      if ((parsed.tvlUsd ?? 0) < minTvl) continue;
      pairs.push(parsed);
    }
    if (!hasNextPage || rows.length === 0) break;
  }

  const result: DiscoverRwaPairsResult = {
    pairs: sortPairs(pairs, sortBy),
    scannedPools,
    pagesFetched,
    fetchedAt: new Date().toISOString(),
    pairingRuleSummary: PAIRING_RULE_SUMMARY,
    estimatedFeeAprLabel: FEE_APR_ESTIMATE_LABEL,
    source: `${RAYDIUM_API_V3}/pools/info/list?poolType=concentrated`,
  };

  cache = { key: cacheKey, expiresAt: Date.now() + CACHE_TTL_MS, value: result };
  return result;
}

/** Test helper to clear the module cache. */
export function clearRwaPairsCache() {
  cache = null;
}

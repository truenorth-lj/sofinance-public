import "@/lib/engine-host";
import "server-only";

import { MAX_POSITION_VALUES, readPositionValues, type RhcPositionValueRow } from "@sofinance/engine/protocols/uniswap-v4/position-value";
import type { PublicClient } from "viem";
import { AsyncCache } from "./async-cache";
import { getRwaConfig } from "./config/rwa-env";
import { createScanClient } from "./rhc-position-scan";
import { getRwaStore } from "./rwa-store";
import type { SnapshotRhcPools } from "./rwa-store-types";

/**
 * Liquidity amounts and unclaimed fees of Robinhood Chain Uniswap v4 position NFTs (public data, by NFT id), plus
 * USD prices per token, for the `/app` detail panel. RPC: the official public endpoint through the scan client
 * (same gate, spacing and 429 cooldown as the holdings scan; never `RHC_RPC_URL`), two multicalls per uncached
 * request. Read-only: nothing is simulated, built or signed.
 *
 * USD prices come only from what the APR cron already saved in `rwa_pool_latest` (the pool summary's
 * `tokenPricesUsd`, taken from the cron's existing GeckoTerminal `/pools/multi` / DexScreener batch). This path never
 * calls GeckoTerminal or DexScreener. No store, no saved price, or a save older than 48h: the price is null (a dash).
 */
export type { RhcPositionValueRow };
export type RhcPositionValuesResult = { state: "values"; values: RhcPositionValueRow[]; checkedAt: number };

const VALUES_TTL_MS = 30_000;
/** A saved price older than this is not shown (PM, 2026-11-01). */
const STORED_PRICE_MAX_AGE_MS = 48 * 60 * 60_000;
const cache = new AsyncCache<RhcPositionValuesResult>({ ttlMs: VALUES_TTL_MS, failureTtlMs: 10_000, maxEntries: 500 });
const storedCache = new AsyncCache<SnapshotRhcPools | null>({ ttlMs: 60_000, failureTtlMs: 30_000, maxEntries: 1 });
let client: PublicClient | null = null;

type TokenPrices = { token0: number; token1: number };
export type StoredRhcPools = () => Promise<SnapshotRhcPools | null>;

/** The cron's saved RHC pool summaries (one DB read, cached 60s); null without a store (local dev) or on any error. */
const readStoredPools: StoredRhcPools = () => storedCache.get("pools", async () => {
  if (!getRwaConfig().enabled) return null;
  try { return await getRwaStore().request({ op: "rhcPools" }); } catch { return null; }
});

const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** Pool id (lowercase) → saved token USD prices, only when the save is at most 48h old. */
function storedTokenPrices(snapshot: SnapshotRhcPools | null, now = Date.now()): Map<string, TokenPrices> {
  const out = new Map<string, TokenPrices>();
  const observed = snapshot?.observedAt ? Date.parse(snapshot.observedAt) : NaN;
  if (!snapshot || !Number.isFinite(observed) || now - observed > STORED_PRICE_MAX_AGE_MS) return out;
  for (const pool of snapshot.pools) {
    const p = pool.tokenPricesUsd;
    if (p && positive(p.token0) && positive(p.token1)) out.set(pool.poolId.toLowerCase(), { token0: p.token0, token1: p.token1 });
  }
  return out;
}

/** Parses `ids=1,2,3` (decimal NFT ids, deduplicated, at most `MAX_POSITION_VALUES`); null when malformed or empty. */
export function parsePositionIds(raw: string | null): bigint[] | null {
  const parts = (raw ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (!parts.length || parts.length > MAX_POSITION_VALUES || parts.some(p => !/^[0-9]{1,30}$/.test(p))) return null;
  return [...new Set(parts.map(p => BigInt(p).toString()))].map(BigInt);
}

export async function rhcPositionValues(ids: bigint[], deps: { client?: PublicClient; storedPools?: StoredRhcPools; now?: () => number } = {}): Promise<RhcPositionValuesResult> {
  const key = ids.map(String).sort().join(",");
  return cache.get(key, async () => {
    const values = await readPositionValues(deps.client ?? (client ??= createScanClient()), ids);
    const snapshot = values.length ? await (deps.storedPools ?? readStoredPools)().catch(() => null) : null;
    const prices = storedTokenPrices(snapshot, deps.now?.() ?? Date.now());
    return {
      state: "values",
      values: values.map(v => {
        const p = prices.get(v.poolId.toLowerCase());
        return { ...v, priceUsd0: p?.token0 ?? null, priceUsd1: p?.token1 ?? null };
      }),
      checkedAt: Date.now(),
    };
  });
}

/** Test hook. */
export function resetRhcPositionValuesCache(): void { cache.clear(); storedCache.clear(); client = null; }

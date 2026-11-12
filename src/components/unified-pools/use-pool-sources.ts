"use client";

import { useCallback, useEffect, useState } from "react";
import { SUPPORTED } from "@/lib/unified-positions/model";
import { RWA_PAIRS_LIST_PATH, fetchRwaPairsList } from "@/lib/rwa-pairs-list";
import type { SnapshotSourceTime } from "@/lib/snapshot-updated";
import type { TokenIconMap } from "@/lib/token-icons/map";
import type { PoolChain, UnifiedProtocol } from "@/lib/unified-pools/model";

/** Which sources this deployment may show; computed from the code flags on the server and passed down. */
export type UnifiedPoolFlags = {
  orca: boolean;
  meteora: boolean;
  rhc: boolean;
};

export type PoolSourceId = "raydium" | "orca" | "meteora" | "rhc";

export const SOURCE_ERROR: Record<PoolSourceId, string> = {
  raydium: "Raydium pools could not be loaded right now. Refresh to try again.",
  orca: "Orca pools could not be loaded right now.",
  meteora: "Meteora pools could not be loaded right now.",
  rhc: "Robinhood Chain pools could not be loaded right now. SoFinance could not reach the chain or its price source.",
};

/** `icons`: token icon links stored by the daily refresh, served with `/api/rwa-pairs` (`tokenIcons`). */
/** `updated`: when each chain's saved list was written (`fetchedAt`), for the "Updated … UTC" line. */
/** `rwaList`: pool keys from `/api/rwa-pairs` (its Meteora rows are feed `meteora-dlmm-rwa-v1`, with a saved APR snapshot). */
/** Row shapes match `/api/rwa-pairs` and `/api/protocol-pools`; typed loosely here to avoid a DEX-module import. */
export type Loaded = {
  rows: Array<{ poolAddress: string }>;
  rhc: Array<{ poolId: string }>;
  icons?: TokenIconMap;
  updated: SnapshotSourceTime[];
  rwaList?: string[];
};

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  const body = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok || !body) throw new Error(body?.error || `Request failed (${response.status})`);
  return body;
}

type RwaPairsBody = {
  pairs: Array<{ poolAddress: string }>;
  tokenIcons?: TokenIconMap;
  fetchedAt?: string;
  freshness?: { stale?: boolean };
};

type ProtocolPoolsBody = { pairs: Array<{ poolAddress: string }> };

type RhcPoolsBody = {
  pools: Array<{ poolId: string }>;
  fetchedAt?: string;
  snapshot?: { stale?: boolean };
};

/**
 * One fetchable pool list. The 6 previously inlined DEX/chain branches live in this metadata
 * (and in `PROTOCOL_META` / `CHAIN_META`) instead of `===` checks in the panel.
 */
export type PoolSourceSpec = {
  source: PoolSourceId;
  url: string;
  enabled: (flags: UnifiedPoolFlags) => boolean;
  map: (body: unknown) => Partial<Loaded>;
  /** When set, used instead of `getJson(url)` so the RWA list keeps its existing fetch helper. */
  fetch?: (signal?: AbortSignal) => Promise<unknown>;
};

export const POOL_SOURCES: readonly PoolSourceSpec[] = [
  {
    source: "raydium",
    url: RWA_PAIRS_LIST_PATH,
    enabled: () => true,
    fetch: (signal) => fetchRwaPairsList<RwaPairsBody>(signal),
    map: (raw) => {
      const body = raw as RwaPairsBody;
      return {
        rows: body.pairs,
        icons: body.tokenIcons,
        rwaList: (Array.isArray(body.pairs) ? body.pairs : []).map((row) => `solana:${row.poolAddress}`),
        updated: body.fetchedAt
          ? [{ chain: "solana" as const, fetchedAt: body.fetchedAt, stale: body.freshness?.stale ?? false }]
          : [],
      };
    },
  },
  {
    source: "orca",
    url: "/api/protocol-pools?protocol=orca-whirlpool",
    enabled: (flags) => flags.orca,
    map: (raw) => ({ rows: (raw as ProtocolPoolsBody).pairs }),
  },
  {
    source: "meteora",
    url: "/api/protocol-pools?protocol=meteora-dlmm",
    enabled: (flags) => flags.meteora,
    map: (raw) => ({ rows: (raw as ProtocolPoolsBody).pairs }),
  },
  {
    source: "rhc",
    url: "/api/protocol-pools?protocol=uniswap-v4-rhc",
    enabled: (flags) => flags.rhc,
    map: (raw) => {
      const body = raw as RhcPoolsBody;
      return {
        rhc: body.pools,
        updated: body.fetchedAt
          ? [{ chain: "robinhood" as const, fetchedAt: body.fetchedAt, stale: body.snapshot?.stale ?? false }]
          : [],
      };
    },
  },
];

/** Per-protocol UI/open metadata. Looked up by id so the panel does not branch on DEX literals. */
export type ProtocolMeta = {
  planFallback?: typeof SUPPORTED;
  externalPoolUrl?: (poolAddress: string) => string;
  /** Open with the panel's existing native dialog (Raydium Create position or RHC). */
  opensNativeModal?: boolean;
};

export const PROTOCOL_META: Partial<Record<UnifiedProtocol, ProtocolMeta>> = {
  "raydium-clmm": {
    planFallback: SUPPORTED,
    externalPoolUrl: (poolId) => `https://raydium.io/clmm/create-position/?pool_id=${poolId}`,
    opensNativeModal: true,
  },
  "uniswap-v4-rhc": { opensNativeModal: true },
};

export type ChainMeta = {
  showHighestRange?: boolean;
  nullFeeLabel: string;
  opensRhcDialog?: boolean;
};

export const CHAIN_META: Record<PoolChain, ChainMeta> = {
  solana: { showHighestRange: true, nullFeeLabel: "—" },
  robinhood: { showHighestRange: false, nullFeeLabel: "Dynamic", opensRhcDialog: true },
};

export const protocolMeta = (protocol: string): ProtocolMeta | undefined =>
  PROTOCOL_META[protocol as UnifiedProtocol];

export const chainMeta = (chain: string): ChainMeta | undefined =>
  CHAIN_META[chain as PoolChain];

const emptyLoaded = (): Loaded => ({ rows: [], rhc: [], updated: [] });

async function runSource(spec: PoolSourceSpec, signal?: AbortSignal): Promise<Partial<Loaded>> {
  const body = spec.fetch ? await spec.fetch(signal) : await getJson(spec.url, signal);
  return spec.map(body);
}

function mergeLoaded(results: PromiseSettledResult<Partial<Loaded>>[], sources: readonly PoolSourceSpec[]): {
  loaded: Loaded;
  errors: Partial<Record<PoolSourceId, string>>;
} {
  const loaded = emptyLoaded();
  const errors: Partial<Record<PoolSourceId, string>> = {};
  results.forEach((result, index) => {
    const source = sources[index]!.source;
    if (result.status !== "fulfilled") {
      errors[source] = SOURCE_ERROR[source];
      return;
    }
    loaded.rows.push(...(Array.isArray(result.value.rows) ? result.value.rows : []));
    loaded.rhc.push(...(Array.isArray(result.value.rhc) ? result.value.rhc : []));
    if (result.value.icons) loaded.icons = result.value.icons;
    if (result.value.rwaList) loaded.rwaList = result.value.rwaList;
    loaded.updated.push(...(result.value.updated ?? []));
  });
  return { loaded, errors };
}

/** Loads every enabled pool source (table-driven) and re-reads the saved lists every minute while the tab is visible. */
export function usePoolSources(flags: UnifiedPoolFlags): {
  loaded: Loaded;
  errors: Partial<Record<PoolSourceId, string>>;
  loading: boolean;
  refreshKey: number;
  load: (signal?: AbortSignal) => Promise<void>;
  refresh: () => void;
} {
  const [loaded, setLoaded] = useState<Loaded>(emptyLoaded);
  const [errors, setErrors] = useState<Partial<Record<PoolSourceId, string>>>({});
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const sources = POOL_SOURCES.filter((spec) => spec.enabled(flags));
    const results = await Promise.allSettled(sources.map((spec) => runSource(spec, signal)));
    if (signal?.aborted) return;
    const next = mergeLoaded(results, sources);
    setLoaded(next.loaded);
    setErrors(next.errors);
    setLoading(false);
    // Discovery flags only (same as the previous inline loader).
  }, [flags.orca, flags.meteora, flags.rhc]); // eslint-disable-line react-hooks/exhaustive-deps -- see above

  useEffect(() => {
    const aborter = new AbortController();
    const timer = window.setTimeout(() => { void load(aborter.signal); }, 0);
    return () => { window.clearTimeout(timer); aborter.abort(); };
  }, [load]);

  // Same cadence as the old RWA pairs list: re-read the saved lists and APR every minute while the tab is visible.
  useEffect(() => {
    const aborter = new AbortController();
    const timer = window.setInterval(() => {
      if (!document.hidden) { setRefreshKey((key) => key + 1); void load(aborter.signal); }
    }, 60_000);
    return () => { window.clearInterval(timer); aborter.abort(); };
  }, [load]);

  const refresh = useCallback(() => {
    setRefreshKey((key) => key + 1);
    setLoading(true);
    void load();
  }, [load]);

  return { loaded, errors, loading, refreshKey, load, refresh };
}

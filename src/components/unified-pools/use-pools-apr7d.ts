"use client";

import { useEffect, useMemo, useState } from "react";
import { summarizeApr7d, type Apr7dState } from "@/lib/unified-pools/apr7d";
import type { UnifiedPool } from "@/lib/unified-pools/model";
import { loadPoolRangeApr, type RangeAprProtocol } from "../range-apr/pool-range-apr-client";
import { isRhcApr7dEnabled } from "@/lib/protocol-flags";
import { POOL_NOT_TRACKED_MESSAGE } from "@/lib/range-apr/not-clmm-pool";

export type { Apr7dState, AprFreshness } from "@/lib/unified-pools/apr7d";

/** Kept for tests and offline copy when `RHC_APR7D_ENABLED` is off. */
const NO_7D_APR_RHC = "No 7-day estimate for this pool yet.";

/**
 * Estimated highest range APR (7-day average) for every pool in the list (Solana + RHC when the flag is on),
 * through the shared cached client (`pool-range-apr-client`), resolved with the same `highestRangeSummary`
 * the cards and the Create position modal use. `rwaListKeys`: keys of the pools listed by `/api/rwa-pairs`; its Meteora
 * pools (feed `meteora-dlmm-rwa-v1`) read their saved APR snapshot (see `rangeAprUrl`).
 */
export function usePoolsApr7d(pools: readonly UnifiedPool[], refreshKey = 0,
  rwaListKeys?: ReadonlySet<string>): Record<string, Apr7dState> {
  const [settled, setSettled] = useState<Record<string, Apr7dState>>({});
  const wanted = useMemo(
    () => pools.filter((pool) => pool.chain === "solana" || (pool.chain === "robinhood" && isRhcApr7dEnabled()))
      .map((pool) => ({ key: pool.key, poolAddress: pool.poolAddress, protocol: pool.protocol as RangeAprProtocol,
        rwaList: rwaListKeys?.has(pool.key) ?? false })),
    [pools, rwaListKeys],
  );
  const wantedKey = wanted.map((entry) => (entry.rwaList ? `${entry.key}#rwa` : entry.key)).join(",");

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      for (const entry of wanted) {
        (entry.rwaList ? loadPoolRangeApr(entry.poolAddress, entry.protocol, { rwaList: true })
          : loadPoolRangeApr(entry.poolAddress, entry.protocol)).then(
          (payload) => {
            if (cancelled) return;
            setSettled((previous) => ({ ...previous, [entry.key]: summarizeApr7d(payload, entry.protocol, Date.now()) }));
          },
          (error: unknown) => {
            if (cancelled) return;
            // A pool the server does not track says so; anything else is an outage.
            const reason = error instanceof Error && error.message === POOL_NOT_TRACKED_MESSAGE ? POOL_NOT_TRACKED_MESSAGE : "APR data is temporarily unavailable.";
            setSettled((previous) => ({ ...previous, [entry.key]: { status: "missing", reason } }));
          },
        );
      }
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // `wantedKey` stands for `wanted` (same pools → same requests).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey, refreshKey]);

  return useMemo(() => {
    const out: Record<string, Apr7dState> = {};
    for (const pool of pools) {
      out[pool.key] = pool.chain === "robinhood" && !isRhcApr7dEnabled()
        ? { status: "missing", reason: NO_7D_APR_RHC }
        : settled[pool.key] ?? { status: "loading" };
    }
    return out;
  }, [pools, settled]);
}

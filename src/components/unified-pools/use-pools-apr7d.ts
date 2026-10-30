"use client";

import { useEffect, useMemo, useState } from "react";
import { summarizeApr7d, type Apr7dState } from "@/lib/unified-pools/apr7d";
import type { UnifiedPool } from "@/lib/unified-pools/model";
import { loadPoolRangeApr, type RangeAprProtocol } from "../range-apr/pool-range-apr-client";
import { isRhcApr7dEnabled } from "@/lib/protocol-flags";

export type { Apr7dState, AprFreshness } from "@/lib/unified-pools/apr7d";

/** Kept for tests and offline copy when `RHC_APR7D_ENABLED` is off. */
export const NO_7D_APR_RHC = "No 7-day estimate for this pool yet; see the 24h estimate.";

/**
 * Estimated highest range APR (7-day average) for every pool in the list (Solana + RHC when the flag is on),
 * through the shared cached client (`pool-range-apr-client`), resolved with the same `highestRangeSummary`
 * the cards and the Create position modal use.
 */
export function usePoolsApr7d(pools: readonly UnifiedPool[], refreshKey = 0): Record<string, Apr7dState> {
  const [settled, setSettled] = useState<Record<string, Apr7dState>>({});
  const wanted = useMemo(
    () => pools.filter((pool) => pool.chain === "solana" || (pool.chain === "robinhood" && isRhcApr7dEnabled()))
      .map((pool) => ({ key: pool.key, poolAddress: pool.poolAddress, protocol: pool.protocol as RangeAprProtocol })),
    [pools],
  );
  const wantedKey = wanted.map((entry) => entry.key).join(",");

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      for (const entry of wanted) {
        loadPoolRangeApr(entry.poolAddress, entry.protocol).then(
          (payload) => {
            if (cancelled) return;
            setSettled((previous) => ({ ...previous, [entry.key]: summarizeApr7d(payload, entry.protocol, Date.now()) }));
          },
          () => { if (!cancelled) setSettled((previous) => ({ ...previous, [entry.key]: { status: "missing", reason: "APR data is temporarily unavailable." } })); },
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

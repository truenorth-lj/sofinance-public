"use client";

import { useEffect, useMemo, useState } from "react";
import { OPEN_RANGE_UI_PRESETS } from "@sofinance/engine/open-range-presets";
import { highestRangeSummary } from "@/lib/range-apr/preset-list";
import { aprSnapshotExpired } from "@/lib/rwa-freshness";
import type { UnifiedPool } from "@/lib/unified-pools/model";
import { loadPoolRangeApr, type RangeAprProtocol } from "../range-apr/pool-range-apr-client";

export type Apr7dState = { status: "loading" } | { status: "ready"; aprPct: number } | { status: "missing"; reason: string };

/** Robinhood Chain pools publish a 24h estimate only (hook fee × 24h volume / TVL); there is no 7-day range model. */
export const NO_7D_APR_RHC = "No 7-day estimate for this pool yet; see the 24h estimate.";

/**
 * Estimated highest range APR (7-day average) for every Solana pool in the list, through the shared cached client
 * (`pool-range-apr-client`: one request per pool per minute, at most two at a time), resolved with the same
 * `highestRangeSummary` the cards and the Create position modal use, so the list, its sorting and its duplicate
 * hiding agree with the number on each card.
 */
export function usePoolsApr7d(pools: readonly UnifiedPool[], refreshKey = 0): Record<string, Apr7dState> {
  const [settled, setSettled] = useState<Record<string, Apr7dState>>({});
  const wanted = useMemo(
    () => pools.filter((pool) => pool.chain === "solana").map((pool) => ({ key: pool.key, poolAddress: pool.poolAddress, protocol: pool.protocol as RangeAprProtocol })),
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
            const summary = !aprSnapshotExpired(payload, Date.now()) ? highestRangeSummary(OPEN_RANGE_UI_PRESETS, payload) : null;
            setSettled((previous) => ({ ...previous, [entry.key]: summary
              ? { status: "ready", aprPct: summary.aprPct }
              : { status: "missing", reason: payload.sample.degraded ? "Not enough recent trading data for a 7-day estimate." : "No 7-day estimate right now." } }));
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
      out[pool.key] = pool.chain === "robinhood" ? { status: "missing", reason: NO_7D_APR_RHC } : settled[pool.key] ?? { status: "loading" };
    }
    return out;
  }, [pools, settled]);
}

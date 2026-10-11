"use client";

import { useEffect, useState } from "react";
import type { DailyAprPoint } from "@/lib/apr-series";
import { selectBestPlanApr, type BestPlanApr } from "@/lib/lp-plan-best-apr";

export type PoolDailyAprPayload = {
  poolId: string;
  points: DailyAprPoint[];
  fetchedAt: string;
  error?: string;
};

export type PoolYieldState =
  | { status: "idle" }
  | { status: "loading"; poolId: string }
  | { status: "ready"; poolId: string; best: BestPlanApr; fetchedAt: string }
  | { status: "unavailable"; poolId: string; reason: string };

type LoadedYield = Extract<PoolYieldState, { status: "ready" | "unavailable" }>;

async function loadPoolDailyApr(poolId: string, signal: AbortSignal): Promise<PoolDailyAprPayload> {
  const response = await fetch(`/api/pool-daily-apr?poolId=${encodeURIComponent(poolId)}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  const body = (await response.json()) as PoolDailyAprPayload;
  if (!response.ok) throw new Error(body.error || "Failed to load pool daily APR");
  return body;
}

/**
 * Fetches the pool's daily APR once per pool id and picks the best trailing-window average
 * (see `selectBestPlanApr`). Slider/day edits must not
 * retrigger this.
 */
export function usePoolYield(poolId: string | undefined): PoolYieldState {
  const [loaded, setLoaded] = useState<LoadedYield | null>(null);

  useEffect(() => {
    if (!poolId) return;
    const aborter = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const payload = await loadPoolDailyApr(poolId, aborter.signal);
          if (aborter.signal.aborted) return;
          const fetchedAtSeconds = Date.parse(payload.fetchedAt) / 1000;
          const best = selectBestPlanApr(
            payload.points,
            Number.isFinite(fetchedAtSeconds) ? fetchedAtSeconds : undefined,
          );
          if (best === null) {
            setLoaded({
              status: "unavailable",
              poolId,
              reason: "No complete UTC days with both volume and TVL, so there is no average yield to show.",
            });
            return;
          }
          setLoaded({
            status: "ready",
            poolId,
            best,
            fetchedAt: payload.fetchedAt,
          });
        } catch (error) {
          if (aborter.signal.aborted) return;
          setLoaded({
            status: "unavailable",
            poolId,
            reason: error instanceof Error ? error.message : "Pool daily APR lookup failed",
          });
        }
      })();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      aborter.abort();
    };
  }, [poolId]);

  if (!poolId) return { status: "idle" };
  if (!loaded || loaded.poolId !== poolId) return { status: "loading", poolId };
  return loaded;
}

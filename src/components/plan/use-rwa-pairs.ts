"use client";

import { useEffect, useState } from "react";
import type { PlanPairOption } from "@/lib/lp-plan-selection";
import { fetchRwaPairsList } from "@/lib/rwa-pairs-list";

type RwaPairRow = {
  poolAddress: string;
  wrappedSymbol: string;
  plainSymbol: string;
  feeTierBps?: number | null;
  tvlUsd?: number | null;
};

type RwaPairsResponse = {
  pairs?: RwaPairRow[];
  error?: string;
};

export type RwaPairsState =
  | { status: "loading" }
  | { status: "ready"; rows: PlanPairOption[] }
  | { status: "unavailable"; reason: string };

type LoadedPairs = Extract<RwaPairsState, { status: "ready" | "unavailable" }>;

async function loadRwaPairs(signal: AbortSignal): Promise<PlanPairOption[]> {
  const body = await fetchRwaPairsList<RwaPairsResponse>(signal);
  return (body.pairs ?? [])
    .filter((row) => row.poolAddress && row.wrappedSymbol && row.plainSymbol)
    .map((row) => ({
      poolAddress: row.poolAddress,
      wrappedSymbol: row.wrappedSymbol,
      plainSymbol: row.plainSymbol,
      feeTierBps: row.feeTierBps ?? null,
      tvlUsd: row.tvlUsd ?? null,
    }));
}

/** Same cached `/api/rwa-pairs` source the RWA pairs page uses. */
export function useRwaPairs(): RwaPairsState {
  const [loaded, setLoaded] = useState<LoadedPairs | null>(null);

  useEffect(() => {
    const aborter = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const rows = await loadRwaPairs(aborter.signal);
          if (aborter.signal.aborted) return;
          setLoaded({ status: "ready", rows });
        } catch (error) {
          if (aborter.signal.aborted) return;
          setLoaded({
            status: "unavailable",
            reason: error instanceof Error ? error.message : "RWA pair lookup failed",
          });
        }
      })();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      aborter.abort();
    };
  }, []);

  return loaded ?? { status: "loading" };
}

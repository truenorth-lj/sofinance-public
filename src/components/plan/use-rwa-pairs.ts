"use client";

import { useEffect, useState } from "react";
import type { PlanPairOption } from "@/lib/lp-plan-selection";

type RwaPairRow = {
  poolAddress: string;
  wrappedSymbol: string;
  plainSymbol: string;
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
  const response = await fetch("/api/rwa-pairs?minTvl=0&maxPages=10&sortBy=estimatedFeeApr", {
    signal,
    headers: { Accept: "application/json" },
  });
  const body = (await response.json()) as RwaPairsResponse;
  if (!response.ok) throw new Error(body.error || "Failed to load RWA pairs");
  return (body.pairs ?? [])
    .filter((row) => row.poolAddress && row.wrappedSymbol && row.plainSymbol)
    .map((row) => ({
      poolAddress: row.poolAddress,
      wrappedSymbol: row.wrappedSymbol,
      plainSymbol: row.plainSymbol,
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

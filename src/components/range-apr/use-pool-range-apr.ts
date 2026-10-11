"use client";

import { useEffect, useState } from "react";
import type { PoolRangeAprPayload } from "@/lib/range-apr/types";
import { loadPoolRangeApr } from "./pool-range-apr-client";

export type PoolRangeAprState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: PoolRangeAprPayload }
  | { status: "error"; message: string };

type Settled = { poolId: string; result: { data: PoolRangeAprPayload } | { message: string } };

/** Loads the per-pool range APR payload (cached and de-duplicated in `pool-range-apr-client`). */
export function usePoolRangeApr(poolId: string | null): PoolRangeAprState {
  const [settled, setSettled] = useState<Settled | null>(null);

  useEffect(() => {
    if (!poolId) return;
    let cancelled = false;
    // Deferred like the other data hooks so state is never set synchronously inside the effect.
    const timer = window.setTimeout(() => {
      loadPoolRangeApr(poolId).then(
        (data) => { if (!cancelled) setSettled({ poolId, result: { data } }); },
        (error: unknown) => {
          if (!cancelled) {
            setSettled({ poolId, result: { message: error instanceof Error ? error.message : "Range APR estimate unavailable" } });
          }
        },
      );
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [poolId]);

  if (!poolId) return { status: "idle" };
  if (!settled || settled.poolId !== poolId) return { status: "loading" };
  return "data" in settled.result
    ? { status: "ready", data: settled.result.data }
    : { status: "error", message: settled.result.message };
}

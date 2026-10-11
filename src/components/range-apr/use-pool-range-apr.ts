"use client";

import { useEffect, useState } from "react";
import type { PoolRangeAprPayload } from "@/lib/range-apr/types";
import { loadPoolRangeApr } from "./pool-range-apr-client";

export type PoolRangeAprState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: PoolRangeAprPayload }
  | { status: "error"; message: string };

const DEGRADED_RETRY_MS = 10_000;
const MAX_DEGRADED_RETRIES = 3;

type Settled = { poolId: string; result: { data: PoolRangeAprPayload } | { message: string } };

/** Loads the per-pool range APR payload (cached and de-duplicated in `pool-range-apr-client`). */
export function usePoolRangeApr(poolId: string | null): PoolRangeAprState {
  const [settled, setSettled] = useState<Settled | null>(null);
  const [attempt, setAttempt] = useState(0);

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
  }, [poolId, attempt]);

  // A degraded payload has no numbers; ask again a few times (the client cache expires it after a few seconds).
  const degraded = !!settled && settled.poolId === poolId && "data" in settled.result && settled.result.data.sample.degraded;
  useEffect(() => {
    if (!degraded || attempt >= MAX_DEGRADED_RETRIES) return;
    const timer = window.setTimeout(() => setAttempt((value) => value + 1), DEGRADED_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [degraded, attempt]);

  if (!poolId) return { status: "idle" };
  if (!settled || settled.poolId !== poolId) return { status: "loading" };
  return "data" in settled.result
    ? { status: "ready", data: settled.result.data }
    : { status: "error", message: settled.result.message };
}

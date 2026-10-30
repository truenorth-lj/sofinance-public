// @vitest-environment happy-dom

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnifiedPool } from "@/lib/unified-pools/model";
import { NO_7D_APR_RHC, usePoolsApr7d, type Apr7dState } from "./use-pools-apr7d";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("../range-apr/pool-range-apr-client", () => ({ loadPoolRangeApr: () => new Promise(() => {}) }));

const rhc = (poolFeeApr7dPct: number | null | undefined): UnifiedPool => ({
  key: `robinhood:0x${String(poolFeeApr7dPct)}`, chain: "robinhood", protocol: "uniswap-v4-rhc", poolAddress: "0x1", pairLabel: "SPCX/SPCXon",
  symbolA: "SPCX", symbolB: "SPCXon", nameA: "", nameB: "", mintA: "0xa", mintB: "0xb", feeTierBps: null, tvlUsd: 1, volume24hUsd: 1,
  poolFeeApr24hPct: 0, poolFeeApr7dPct, risks: ["new-chain"],
});

let container: HTMLDivElement; let root: Root; const seen: Record<string, Apr7dState> = {};
function Probe({ pools, onState }: { pools: UnifiedPool[]; onState: (state: Record<string, Apr7dState>) => void }) {
  const state = usePoolsApr7d(pools);
  useEffect(() => { onState(state); }, [state, onState]);
  return null;
}
const record = (state: Record<string, Apr7dState>) => { for (const key of Object.keys(seen)) delete seen[key]; Object.assign(seen, state); };
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe("usePoolsApr7d (Robinhood Chain)", () => {
  it("uses the server's 7-day whole-pool fee APR, and missing (—) when there is none, never 0", async () => {
    const pools = [rhc(0.0007), rhc(null), rhc(undefined), rhc(Number.NaN)];
    await act(async () => { root.render(createElement(Probe, { pools, onState: record })); });
    expect(seen[pools[0]!.key]).toEqual({ status: "ready", aprPct: 0.0007, basis: "pool-fee" });
    for (const pool of pools.slice(1)) expect(seen[pool.key]).toEqual({ status: "missing", reason: NO_7D_APR_RHC });
  });
});

// @vitest-environment happy-dom
// The card's Highest range and 7d APR come from the same resolver as the Create position modal's "Best".
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPEN_RANGE_UI_PRESETS } from "@sofinance/engine/open-range-presets";
import { payloadWithAprs } from "@/lib/range-apr/payload.fixture";
import { buildPresetList } from "@/lib/range-apr/preset-list";
import type { UnifiedPool } from "@/lib/unified-pools/model";
import { usePoolsApr7d, type Apr7dState } from "./use-pools-apr7d";

const mocks = vi.hoisted(() => ({ payload: null as unknown }));
vi.mock("../range-apr/pool-range-apr-client", () => ({ loadPoolRangeApr: async () => mocks.payload }));

const pool = { key: "solana:p1", chain: "solana", protocol: "raydium-clmm", poolAddress: "p1" } as UnifiedPool;
let out: Record<string, Apr7dState> = {};
function Probe({ onState }: { onState: (state: Record<string, Apr7dState>) => void }) {
  const state = usePoolsApr7d([pool]);
  useEffect(() => { onState(state); }, [state, onState]);
  return null;
}
const keep = (state: Record<string, Apr7dState>) => { out = state; };

let container: HTMLDivElement; let root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

async function run(payload: unknown) {
  mocks.payload = payload;
  await act(async () => { root.render(createElement(Probe, { onState: keep })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  return out[pool.key]!;
}

describe("usePoolsApr7d", () => {
  it("names the same range and APR as the modal's Best, with confidence and freshness", async () => {
    const data = payloadWithAprs({ micro: 3, tight: 4, standard: 61, wide: 5 });
    const snapshotAt = new Date().toISOString();
    const state = await run({ ...data, sample: { ...data.sample, confidence: "low" }, freshness: { snapshotAt, stale: true } });
    const best = buildPresetList(OPEN_RANGE_UI_PRESETS, data).best!;
    expect(state).toMatchObject({ status: "ready", lowConfidence: true, freshness: { snapshotAt, delayed: true },
      rangeLabel: OPEN_RANGE_UI_PRESETS.find((preset) => preset.id === best.id)!.label });
  });

  it("fresh under 26h; 26-48h keeps the number, delayed even if the server said fresh; over 48h it is gone", async () => {
    const data = payloadWithAprs({ micro: 3, tight: 4, standard: 61, wide: 5 });
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    const fresh = await run({ ...data, freshness: { snapshotAt: hoursAgo(20), chainObservedAt: hoursAgo(20), stale: false, lastAttemptStatus: "ok" } });
    expect(fresh).toMatchObject({ status: "ready", freshness: { delayed: false } });
    await act(async () => root.unmount()); root = createRoot(container);
    const old = await run({ ...data, freshness: { snapshotAt: hoursAgo(27), chainObservedAt: hoursAgo(27), stale: false, lastAttemptStatus: "ok" } });
    expect(old).toMatchObject({ status: "ready", aprPct: 61, freshness: { delayed: true } });
    await act(async () => root.unmount()); root = createRoot(container);
    const expired = await run({ ...data, freshness: { snapshotAt: hoursAgo(49), chainObservedAt: hoursAgo(49), stale: false, lastAttemptStatus: "ok" } });
    expect(expired).toMatchObject({ status: "missing", freshness: { delayed: true } });
  });

  it("a failed last refresh still says delayed", async () => {
    const data = payloadWithAprs({ micro: 3, tight: 4, standard: 61, wide: 5 });
    const at = new Date().toISOString();
    expect(await run({ ...data, freshness: { snapshotAt: at, chainObservedAt: at, stale: false, lastAttemptStatus: "error" } }))
      .toMatchObject({ freshness: { delayed: true } });
  });
});

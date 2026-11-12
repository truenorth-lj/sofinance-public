// @vitest-environment happy-dom

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RWA_PAIRS_LIST_PATH } from "@/lib/rwa-pairs-list";
import { POOL_SOURCES, SOURCE_ERROR, chainMeta, protocolMeta, usePoolSources, type Loaded, type UnifiedPoolFlags } from "./use-pool-sources";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FLAGS: UnifiedPoolFlags = { orca: false, meteora: false, meteoraOpen: false, rhc: true };

const solanaRow = { poolAddress: "ray1", protocol: "raydium-clmm", mintA: "a", mintB: "b" };
const orcaRow = { poolAddress: "orca1", protocol: "orca-whirlpool", mintA: "a", mintB: "b" };
const meteoraRow = { poolAddress: "met1", protocol: "meteora-dlmm", mintA: "a", mintB: "b" };
const rhcPool = { poolId: "0xabc", status: "listed", tick: 1, price: null, warnings: [], token0: { symbol: "SPCX" }, token1: { symbol: "SPCXon" } };

let requested: string[] = [];
let fail: Set<string> = new Set();

beforeEach(() => {
  requested = [];
  fail = new Set();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    requested.push(url);
    if ([...fail].some((part) => url.includes(part))) {
      return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
    }
    const body = url.startsWith("/api/rwa-pairs")
      ? { pairs: [solanaRow], tokenIcons: { solana: { a: "icon-a" } }, fetchedAt: "2026-11-12T00:00:00.000Z", freshness: { stale: false } }
      : url.includes("orca-whirlpool") ? { pairs: [orcaRow] }
      : url.includes("meteora-dlmm") ? { pairs: [meteoraRow] }
      : url.includes("uniswap-v4-rhc") ? { pools: [rhcPool], fetchedAt: "2026-11-12T00:01:00.000Z", snapshot: { stale: false } }
      : { pairs: [] };
    return { ok: true, json: async () => body };
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

let container: HTMLDivElement;
let root: Root;
let latest: { loaded: Loaded; errors: Record<string, string | undefined>; loading: boolean } | null = null;

function Probe({ flags }: { flags: UnifiedPoolFlags }) {
  const state = usePoolSources(flags);
  useEffect(() => { latest = { loaded: state.loaded, errors: state.errors, loading: state.loading }; }, [state]);
  return null;
}

async function run(flags: UnifiedPoolFlags = FLAGS) {
  latest = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(createElement(Probe, { flags })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
  return latest!;
}

async function cleanup() {
  await act(async () => root.unmount());
  container.remove();
}

describe("POOL_SOURCES table", () => {
  it("lists each source with a url and a map, and enables optional protocols from flags", () => {
    expect(POOL_SOURCES.map((spec) => spec.source)).toEqual(["raydium", "orca", "meteora", "rhc"]);
    for (const spec of POOL_SOURCES) {
      expect(spec.url).toMatch(/^\/api\//);
      expect(typeof spec.map).toBe("function");
    }
    expect(POOL_SOURCES.find((spec) => spec.source === "raydium")?.url).toBe(RWA_PAIRS_LIST_PATH);
    expect(POOL_SOURCES.find((spec) => spec.source === "orca")?.enabled(FLAGS)).toBe(false);
    expect(POOL_SOURCES.find((spec) => spec.source === "orca")?.enabled({ ...FLAGS, orca: true })).toBe(true);
    expect(POOL_SOURCES.find((spec) => spec.source === "rhc")?.enabled(FLAGS)).toBe(true);
  });
});

describe("usePoolSources", () => {
  it("loads the always-on RWA list and enabled Robinhood Chain source, recording icons, rwaList and updated times", async () => {
    const state = await run();
    expect(state.loading).toBe(false);
    expect(state.errors).toEqual({});
    expect(state.loaded.rows.map((row) => row.poolAddress)).toEqual(["ray1"]);
    expect(state.loaded.rhc.map((row) => row.poolId)).toEqual(["0xabc"]);
    expect(state.loaded.icons).toEqual({ solana: { a: "icon-a" } });
    expect(state.loaded.rwaList).toEqual(["solana:ray1"]);
    expect(state.loaded.updated).toEqual([
      { chain: "solana", fetchedAt: "2026-11-12T00:00:00.000Z", stale: false },
      { chain: "robinhood", fetchedAt: "2026-11-12T00:01:00.000Z", stale: false },
    ]);
    expect(requested.some((url) => url.startsWith("/api/rwa-pairs"))).toBe(true);
    expect(requested.some((url) => url.includes("uniswap-v4-rhc"))).toBe(true);
    expect(requested.some((url) => url.includes("orca-whirlpool") || url.includes("meteora-dlmm"))).toBe(false);
    await cleanup();
  });

  it("fetches Orca and Meteora only when their flags are on", async () => {
    const state = await run({ orca: true, meteora: true, meteoraOpen: true, rhc: false });
    expect(state.loaded.rows.map((row) => row.poolAddress)).toEqual(["ray1", "orca1", "met1"]);
    expect(state.loaded.rhc).toEqual([]);
    expect(requested.some((url) => url.includes("orca-whirlpool"))).toBe(true);
    expect(requested.some((url) => url.includes("meteora-dlmm"))).toBe(true);
    expect(requested.some((url) => url.includes("uniswap-v4-rhc"))).toBe(false);
    await cleanup();
  });

  it("keeps other sources when one fetch fails, and uses the source error copy", async () => {
    fail.add("uniswap-v4-rhc");
    const state = await run();
    expect(state.loaded.rows.map((row) => row.poolAddress)).toEqual(["ray1"]);
    expect(state.loaded.rhc).toEqual([]);
    expect(state.errors.rhc).toBe(SOURCE_ERROR.rhc);
    expect(state.errors.raydium).toBeUndefined();
    await cleanup();
  });
});

describe("source metadata lookups", () => {
  it("describes Raydium and RHC open paths without a DEX-id branch at the call site", () => {
    expect(protocolMeta("raydium-clmm")?.opensNativeModal).toBe(true);
    expect(protocolMeta("raydium-clmm")?.planFallback).toBeTruthy();
    expect(protocolMeta("raydium-clmm")?.externalPoolUrl?.("pool1")).toBe("https://raydium.io/clmm/create-position/?pool_id=pool1");
    expect(protocolMeta("uniswap-v4-rhc")?.opensNativeModal).toBe(true);
    expect(protocolMeta("meteora-dlmm")?.opensNativeModal).toBeUndefined();
    expect(chainMeta("solana")?.showHighestRange).toBe(true);
    expect(chainMeta("robinhood")?.nullFeeLabel).toBe("Dynamic");
    expect(chainMeta("robinhood")?.opensRhcDialog).toBe(true);
  });
});

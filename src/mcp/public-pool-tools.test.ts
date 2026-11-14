// Public, signature-free read tools (list_rwa_pairs, get_pool_range_apr): served from the saved pools snapshot only,
// reachable on the remote route without a token, while every wallet-bound tool keeps its 401.
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cardPayloadWithAprs } from "@/lib/range-apr/payload.fixture";
import type { PoolRangeAprPayload } from "@/lib/range-apr/types";

const backend = vi.hoisted(() => ({ pairs: vi.fn(), store: vi.fn(), live: vi.fn(), enabled: { value: true } }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rwa-store", () => ({ getRwaPairs: backend.pairs, getRwaStore: () => ({ request: backend.store }) }));
vi.mock("@/lib/config/rwa-env", () => ({ getRwaConfig: () => ({ enabled: backend.enabled.value }) }));
vi.mock("@/lib/pool-range-apr", () => ({ fetchPoolRangeApr: backend.live }));

import { POST } from "@/app/api/mcp/route";
import { dispatchTool, isPublicTool, TOOL_DISPATCH } from "./dispatch";
import { listToolDefinitions, PUBLIC_TOOL_NAMES, type ToolName } from "./tool-definitions";
import { quoteOpenPositionSchema, prepareOpenPositionSchema } from "./schemas";
import { resetPoolSnapshotCache, ttlMemo } from "./tools/pool-snapshot";
import { POOL_NOT_LISTED_MESSAGE } from "./tools/pool-apr";
import { VALID_ARGS } from "./test-support/dispatch-fixtures";

const SNAPSHOT = "2026-11-14T12:16:35.000Z";
const NOW = Date.parse(SNAPSHOT) + 3_600_000;
const POOLS = {
  raydiumTsla: "4bMbJzxWyiokwyQC4ndST5sJv6Qnb4viyACzhyFUgRbd",
  meteoraTsla: "8k2c9Kiavx5pbWc2dmzhL7vFp11sLgMcKFfSueq8haAh",
  raydiumSpy: "5jdb8XzZc5L2BvG2DjLrnzeA2Psn9NZsfxwxNwZHypMk",
  newPool: "6GKnUKgPCHZ1jMPnujYfE25VGfjXuDrXNBLem3a5Vjot",
};
const pair = (poolAddress: string, protocol: string, symbolA: string, symbolB: string, baseSymbol: string, tvlUsd: number) => ({
  poolAddress, protocol, mintA: poolAddress, mintB: poolAddress, symbolA, symbolB, nameA: symbolA, nameB: symbolB, baseSymbol,
  wrappedSymbol: `${baseSymbol}x`, plainSymbol: baseSymbol, wrapKind: "suffix-x", relatedness: "same-asset",
  qualificationA: "jupiter", qualificationB: "jupiter", preferredTags: true, jupiterTagsA: [], jupiterTagsB: [],
  feeRate: 0.0005, feeTierBps: 5, tvlUsd, volume24hUsd: 100, fees24hUsd: 1, raydiumFeeApr24h: null,
  estimatedFeeAprPct: 3, estimatedFeeAprLabel: "24h", token2022A: true, token2022B: true,
  freezeRiskA: false, freezeRiskB: false, freezeRisk: false, ...(protocol === "meteora-dlmm" ? { binStep: 1 } : {}),
});
const SNAPSHOT_PAIRS = {
  pairs: [
    pair(POOLS.raydiumTsla, "raydium-clmm", "TSLA", "TSLAx", "TSLA", 2_174),
    pair(POOLS.meteoraTsla, "meteora-dlmm", "TSLA", "TSLAx", "TSLA", 47_249),
    pair(POOLS.raydiumSpy, "raydium-clmm", "SPY", "SPYx", "SPY", 1_777),
    pair(POOLS.newPool, "raydium-clmm", "TTWO", "TTWOx", "TTWO", 112),
  ],
  fetchedAt: SNAPSHOT, source: "store", pairingRuleSummary: "same stock", estimatedFeeAprLabel: "24h",
  scannedPools: 4, pagesFetched: 1, freshness: { snapshotAt: SNAPSHOT, stale: false },
};
function aprPayload(aprs: { micro: number; tight: number; standard: number; wide: number }, days = 7, dataDays = 17): PoolRangeAprPayload {
  const payload = cardPayloadWithAprs(aprs);
  payload.sample = { ...payload.sample, days, dataDays };
  payload.freshness = { snapshotAt: SNAPSHOT, chainObservedAt: SNAPSHOT, volumeObservedAt: SNAPSHOT, stale: false };
  return payload;
}
const APR: Record<string, PoolRangeAprPayload> = {
  [POOLS.raydiumTsla]: aprPayload({ micro: 10, tight: 8, standard: 6, wide: 4 }),
  [POOLS.meteoraTsla]: aprPayload({ micro: 40, tight: 30, standard: 20, wide: 10 }),
  [POOLS.raydiumSpy]: aprPayload({ micro: 20, tight: 15, standard: 12, wide: 5 }),
  [POOLS.newPool]: aprPayload({ micro: 90, tight: 80, standard: 70, wide: 60 }, 7, 3),
};

async function rpc(name: string, args: unknown, headers: Record<string, string> = {}) {
  const response = await POST(new NextRequest("http://localhost/api/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }));
  const json = await response.json() as { result?: { content: { text: string }[]; isError?: boolean }; error?: { message: string } };
  return { response, json, value: json.result ? JSON.parse(json.result.content[0]!.text) : null };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  vi.stubEnv("JUPITER_API_KEY", "test-secret");
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetPoolSnapshotCache();
  backend.enabled.value = true;
  backend.pairs.mockReset().mockResolvedValue(SNAPSHOT_PAIRS);
  backend.store.mockReset().mockImplementation(async ({ op, poolId }: { op: string; poolId: string }) => {
    if (op !== "apr" || !APR[poolId]) throw new Error("unexpected store read");
    return structuredClone(APR[poolId]);
  });
  backend.live.mockReset().mockRejectedValue(new Error("live RPC path must not run"));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("list_rwa_pairs over the remote route, no token", () => {
  it("serves the saved snapshot incl. Meteora, with protocol and 7-day APR, ranked by 7-day APR", async () => {
    const { response, value } = await rpc("list_rwa_pairs", {});
    expect(response.status).toBe(200);
    expect(backend.pairs).toHaveBeenCalledWith({ minTvl: 0, maxPages: 10, sortBy: "estimatedFeeApr" });
    expect(backend.live).not.toHaveBeenCalled();
    expect(value.count).toBe(4);
    expect(value.snapshotAt).toBe(SNAPSHOT);
    expect(value.rangePresets.map((preset: { id: string }) => preset.id)).toEqual(["micro", "tight", "standard", "wide"]);
    const meteora = value.pairs.find((row: { poolAddress: string }) => row.poolAddress === POOLS.meteoraTsla);
    expect(meteora).toMatchObject({ protocol: "meteora-dlmm", protocolName: "Meteora", chain: "solana", binStep: 1 });
    expect(meteora.apr7d).toMatchObject({ status: "ready", highestRangeAprPct: expect.any(Number), dataDelayed: false, snapshotAt: SNAPSHOT });
    // Ready pools by 7-day APR, then the new pool (no APR shown, like the site).
    const order = value.pairs.map((row: { poolAddress: string }) => row.poolAddress);
    expect(order).toEqual([POOLS.meteoraTsla, POOLS.raydiumSpy, POOLS.raydiumTsla, POOLS.newPool]);
    const newPool = value.pairs[3];
    expect(newPool.apr7d).toMatchObject({ status: "new", daysOfData: 3 });
    expect(newPool.apr7d).not.toHaveProperty("highestRangeAprPct");
    expect(JSON.stringify(value)).not.toMatch(/\byield|\bearn|guarantee|backtest/i);
  });

  it("symbol filter answers 'which TSLA pool' with both Raydium and Meteora, reading APR only for matches", async () => {
    const { value } = await rpc("list_rwa_pairs", { symbol: "tsla" });
    expect(value.pairs.map((row: { protocol: string }) => row.protocol)).toEqual(["meteora-dlmm", "raydium-clmm"]);
    expect(backend.store.mock.calls.map(([request]) => request.poolId).sort()).toEqual([POOLS.meteoraTsla, POOLS.raydiumTsla].sort());
  });

  it("repeated calls reuse the cached snapshot (no new store reads within the TTL)", async () => {
    await rpc("list_rwa_pairs", {});
    const reads = backend.store.mock.calls.length;
    await rpc("list_rwa_pairs", { sortBy: "tvl" });
    await rpc("get_pool_range_apr", { poolId: POOLS.meteoraTsla });
    expect(backend.pairs).toHaveBeenCalledTimes(1);
    expect(backend.store).toHaveBeenCalledTimes(reads);
  });

  it("a failed snapshot read is a plain tool error and is not cached", async () => {
    backend.pairs.mockRejectedValueOnce(new Error("Saved pool data is temporarily unavailable"));
    const failed = await rpc("list_rwa_pairs", {});
    expect(failed.response.status).toBe(200);
    expect(failed.json.result?.isError).toBe(true);
    expect((await rpc("list_rwa_pairs", {})).value.count).toBe(4);
  });
});

describe("get_pool_range_apr over the remote route, no token", () => {
  it("returns the four presets with 7-day APR from the saved snapshot (Meteora)", async () => {
    const { response, value } = await rpc("get_pool_range_apr", { poolId: POOLS.meteoraTsla });
    expect(response.status).toBe(200);
    expect(value).toMatchObject({
      poolId: POOLS.meteoraTsla, protocol: "meteora-dlmm", protocolName: "Meteora", pair: "TSLA/TSLAx",
      status: "ready", depositBasisUsd: 1000, window: { days: 7 },
    });
    expect(value.presets.map((preset: { id: string }) => preset.id)).toEqual(["micro", "tight", "standard", "wide"]);
    for (const preset of value.presets) {
      expect(preset).toMatchObject({ status: "ok", aprPct: expect.any(Number), inRangeVolumePct: expect.any(Number), feesPerDayUsd: expect.any(Number) });
    }
    const best = Math.max(...value.presets.map((preset: { aprPct: number }) => preset.aprPct));
    expect(value.highestRange.aprPct).toBeCloseTo(best, 9);
    expect(value.summary.highestRangeAprPct).toBe(value.highestRange.aprPct);
    expect(backend.store).toHaveBeenCalledWith({ op: "apr", poolId: POOLS.meteoraTsla });
    expect(backend.live).not.toHaveBeenCalled();
  });

  it("a new pool returns its status and no APR numbers", async () => {
    const { value } = await rpc("get_pool_range_apr", { poolId: POOLS.newPool });
    expect(value.status).toBe("new");
    expect(value.highestRange).toBeNull();
    for (const preset of value.presets) expect(preset).not.toHaveProperty("aprPct");
  });

  it("a pool outside the saved list is refused without any store or live read", async () => {
    const { json } = await rpc("get_pool_range_apr", { poolId: VALID_ARGS.get_pool_range_apr.poolId });
    expect(json.result?.isError).toBe(true);
    expect(json.result?.content[0]!.text).toContain(POOL_NOT_LISTED_MESSAGE.slice(0, 40));
    expect(backend.store).not.toHaveBeenCalled();
    expect(backend.live).not.toHaveBeenCalled();
  });

  it("validates poolId", async () => {
    const { json } = await rpc("get_pool_range_apr", { poolId: "not a pool" });
    expect(json.result?.isError).toBe(true);
  });
});

describe("protected tools keep their auth", () => {
  const protectedTools = (Object.keys(TOOL_DISPATCH) as ToolName[]).filter((name) => !isPublicTool(name));

  it("exactly list_rwa_pairs and get_pool_range_apr are public, and metadata agrees with dispatch", () => {
    expect((Object.keys(TOOL_DISPATCH) as ToolName[]).filter(isPublicTool).sort()).toEqual([...PUBLIC_TOOL_NAMES].sort());
    expect(protectedTools).toHaveLength(14);
  });

  it.each(protectedTools)("%s without a token => 401 with sign-in guidance", async (name) => {
    const { response, json } = await rpc(name, VALID_ARGS[name]);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect(json.error?.message).toContain("/app/ai");
  });

  it.each(protectedTools)("%s cannot run through the public dispatch context even if a caller tried", async (name) => {
    await expect(dispatchTool(name, VALID_ARGS[name], { surface: "mcp-http-public" })).rejects.toThrow("needs a wallet-bound MCP token");
  });
});

describe("tool annotations", () => {
  const READ = ["list_rwa_pairs", "get_pool_range_apr", "list_positions", "get_position_range_status", "get_position_performance",
    "quote_add_liquidity", "quote_compound", "quote_open_position"];
  it.each(["http", "stdio"] as const)("%s: every tool has annotations; reads are readOnly, submits destructive", (surface) => {
    for (const tool of listToolDefinitions(surface)) {
      expect(tool.annotations, tool.name).toBeDefined();
      expect(tool.annotations!.readOnlyHint, tool.name).toBe(READ.includes(tool.name));
      expect(tool.annotations!.destructiveHint, tool.name).toBe(tool.name.startsWith("submit_"));
    }
  });
});

describe("open tools accept SOL / USDC symbols", () => {
  it.each([["USDC", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"], ["usdc", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
    ["SOL", "So11111111111111111111111111111111111111112"], [" sol ", "So11111111111111111111111111111111111111112"]])("%j resolves to its mint", (symbol, mint) => {
    expect(quoteOpenPositionSchema.parse({ ...VALID_ARGS.quote_open_position, inputMint: symbol }).inputMint).toBe(mint);
    expect(prepareOpenPositionSchema.parse({ ...VALID_ARGS.prepare_open_position, inputMint: symbol }).inputMint).toBe(mint);
  });
  it("a mint address passes through and other text is still rejected", () => {
    expect(quoteOpenPositionSchema.parse(VALID_ARGS.quote_open_position).inputMint).toBe(VALID_ARGS.quote_open_position.inputMint);
    expect(quoteOpenPositionSchema.safeParse({ ...VALID_ARGS.quote_open_position, inputMint: "USDT" }).success).toBe(false);
  });
});

describe("ttlMemo", () => {
  it("de-duplicates in-flight loads, expires, and never caches failures", async () => {
    let now = 0;
    const memo = ttlMemo<number>(1000, 2, () => now);
    const load = vi.fn(async () => 1);
    await Promise.all([memo("a", load), memo("a", load)]);
    expect(load).toHaveBeenCalledTimes(1);
    now = 1001;
    await memo("a", load);
    expect(load).toHaveBeenCalledTimes(2);
    await expect(memo("b", async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(await memo("b", async () => 2)).toBe(2);
  });
});

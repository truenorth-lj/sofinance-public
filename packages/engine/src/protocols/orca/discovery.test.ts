import { describe, expect, it, vi } from "vitest";
import fixture from "../../fixtures/orca-pool-cbbtc-wbtc.json";
import { CBBTC_MINT, ORCA_ALLOWLISTED_POOLS, ORCA_API_V2, ORCA_WHIRLPOOLS_CONFIG, WBTC_WORMHOLE_MINT } from "./constants";
import { fetchOrcaPools, parseOrcaPool } from "./discovery";

const POOL = "4v8ufj8Hj7UvFgtofQJAtzUud5xomwZfEqfCTHZ4wM72";
const raw = () => structuredClone(fixture.data) as Record<string, unknown>;

describe("Orca allowlist", () => {
  it("is exactly cbBTC/WBTC 1 bp", () => {
    expect(ORCA_ALLOWLISTED_POOLS).toEqual([{ poolAddress: POOL, mintA: CBBTC_MINT, mintB: WBTC_WORMHOLE_MINT,
      baseSymbol: "BTC", wrappedSymbol: "cbBTC", plainSymbol: "WBTC" }]);
    expect(Object.isFrozen(ORCA_ALLOWLISTED_POOLS)).toBe(true);
  });
});

describe("parseOrcaPool", () => {
  it("parses the captured Orca API v2 pool (golden)", () => {
    const summary = parseOrcaPool(raw());
    expect(summary).toMatchObject({
      poolAddress: POOL, mintA: CBBTC_MINT, mintB: WBTC_WORMHOLE_MINT, symbolA: "cbBTC", symbolB: "WBTC",
      decimalsA: 8, decimalsB: 8, tickSpacing: 1, feeRate: 0.0001, feeTierBps: 1, protocolFeeShare: 0.13,
      adaptiveFeeEnabled: false, programA: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    });
    expect(summary!.tvlUsd).toBeCloseTo(1263790.70, 2);
    expect(summary!.volume24hUsd).toBeCloseTo(2028277.77, 2);
    expect(summary!.fees24hUsd).toBeCloseTo(207.3769, 4);
    expect(summary!.lpFees24hUsd).toBeCloseTo(207.3769 * 0.87, 4);
    expect(summary).toMatchSnapshot();
  });

  it.each([
    ["non-allowlisted pool", (p: Record<string, unknown>) => { p.address = "32fJx2PJNBVHqTPwufmeTUystaEPmUQ2WhQXFoouiWHb"; }],
    ["wrong mint pair", (p: Record<string, unknown>) => { p.tokenMintB = "So11111111111111111111111111111111111111112"; }],
    ["same mint twice", (p: Record<string, unknown>) => { p.tokenMintB = CBBTC_MINT; }],
    ["foreign WhirlpoolsConfig", (p: Record<string, unknown>) => { p.whirlpoolsConfig = "11111111111111111111111111111111"; }],
    ["Orca warning", (p: Record<string, unknown>) => { p.hasWarning = true; }],
    ["non-whirlpool type", (p: Record<string, unknown>) => { p.poolType = "splash"; }],
    ["missing fee rate", (p: Record<string, unknown>) => { delete p.feeRate; }],
    ["out-of-range protocol fee", (p: Record<string, unknown>) => { p.protocolFeeRate = 20_000; }],
  ])("rejects %s", (_name, mutate) => {
    const pool = raw();
    mutate(pool);
    expect(parseOrcaPool(pool)).toBeNull();
  });

  it("accepts the pair in either mint order and rejects non-objects", () => {
    const pool = raw();
    [pool.tokenMintA, pool.tokenMintB] = [pool.tokenMintB, pool.tokenMintA];
    expect(parseOrcaPool(pool)?.poolAddress).toBe(POOL);
    for (const value of [null, undefined, "x", 1, []]) expect(parseOrcaPool(value)).toBeNull();
  });

  it("requires the main config", () => {
    expect(raw().whirlpoolsConfig).toBe(ORCA_WHIRLPOOLS_CONFIG);
  });
});

describe("fetchOrcaPools", () => {
  it("GETs each allowlisted pool from Orca API v2 (read-only)", async () => {
    const fetcher = vi.fn(async () => Response.json(fixture));
    const pools = await fetchOrcaPools({ fetcher: fetcher as unknown as typeof fetch });
    expect(pools.map(pool => pool.poolAddress)).toEqual([POOL]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${ORCA_API_V2}/pools/${POOL}`);
    expect(init.method ?? "GET").toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("skips failed or gated pools and ignores non-allowlisted ids", async () => {
    expect(await fetchOrcaPools({ fetcher: (async () => new Response("no", { status: 503 })) as typeof fetch })).toEqual([]);
    expect(await fetchOrcaPools({ fetcher: (async () => { throw new Error("down"); }) as typeof fetch })).toEqual([]);
    expect(await fetchOrcaPools({ fetcher: (async () => Response.json({ data: { ...fixture.data, hasWarning: true } })) as typeof fetch })).toEqual([]);
    const fetcher = vi.fn(async () => Response.json(fixture));
    expect(await fetchOrcaPools({ fetcher: fetcher as unknown as typeof fetch, poolAddresses: ["32fJx2PJNBVHqTPwufmeTUystaEPmUQ2WhQXFoouiWHb"] })).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("propagates caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(fetchOrcaPools({ signal: controller.signal, fetcher: (async (_u: string, init?: RequestInit) => {
      init?.signal?.throwIfAborted(); return Response.json(fixture);
    }) as typeof fetch })).rejects.toThrow();
  });
});

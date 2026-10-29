import { describe, expect, it, vi } from "vitest";
import fixture from "../../fixtures/meteora-dlmm-pool-cbbtc-wbtc.json";
import { CBBTC_MINT, METEORA_ALLOWLISTED_POOLS, METEORA_DLMM_DATAPI, SPL_TOKEN_PROGRAM_ID, WBTC_WORMHOLE_MINT } from "./constants";
import { fetchMeteoraPools, parseMeteoraPool } from "./discovery";

const POOL = "53oyyjgybx6dH7i5aGeKfBUi3xPJQDeBkaENPri57x2H";
type Obj = Record<string, unknown>;
// Mutable view of the datapi fixture for the rejection cases (parseMeteoraPool takes `unknown`).
type Raw = {
  address?: unknown; is_blacklisted?: unknown; reward_mint_x?: unknown; protocol_fees?: Obj;
  token_x: Obj; token_y: Obj; pool_config: Obj;
};
const raw = () => structuredClone(fixture) as unknown as Raw;

describe("Meteora allowlist", () => {
  it("is exactly cbBTC/WBTC bin step 1 (SPL/SPL, no SOL)", () => {
    expect(METEORA_ALLOWLISTED_POOLS).toEqual([{ poolAddress: POOL, mintX: CBBTC_MINT, mintY: WBTC_WORMHOLE_MINT,
      tokenProgramX: SPL_TOKEN_PROGRAM_ID, tokenProgramY: SPL_TOKEN_PROGRAM_ID, binStep: 1,
      baseSymbol: "BTC", wrappedSymbol: "cbBTC", plainSymbol: "WBTC" }]);
    expect(Object.isFrozen(METEORA_ALLOWLISTED_POOLS)).toBe(true);
    expect(Object.isFrozen(METEORA_ALLOWLISTED_POOLS[0])).toBe(true);
  });
});

describe("parseMeteoraPool", () => {
  it("parses the captured datapi pool (golden)", () => {
    const summary = parseMeteoraPool(raw());
    expect(summary).toMatchObject({
      poolAddress: POOL, mintX: CBBTC_MINT, mintY: WBTC_WORMHOLE_MINT, symbolX: "cbBTC", symbolY: "WBTC",
      decimalsX: 8, decimalsY: 8, binStep: 1, baseFeeRate: 0.0001, baseFeeBps: 1, protocolFeeShare: 0.05,
      dynamicFeeRate: 0, freezeAuthorityDisabledX: false, freezeAuthorityDisabledY: true,
      reserveX: "5LaTKNpjhHoxmWrCFPqhSkUHKdzpK3b95PdDwQecCxmH", reserveY: "Hrz5yLrAKJtC5FttkWEupPwsYSVteEJiKoNrwvjnvxRs",
      hasFarm: false, hasRewards: false, createdAt: "2024-11-07T14:28:59.000Z",
    });
    expect(summary!.tvlUsd).toBeCloseTo(336203.4703, 4);
    expect(summary!.volume24hUsd).toBeCloseTo(44848.2047, 4);
    expect(summary!.fees24hUsd).toBeCloseTo(4.247999, 6);
    expect(summary!.lpFees24hUsd).toBeCloseTo(4.247998606572472 - 0.35919833168257265, 9);
    expect(summary!.price).toBeCloseTo(1.0016012, 7);
    expect(summary).toMatchSnapshot();
  });

  it.each([
    ["non-allowlisted pool", (p: Raw) => { p.address = "8k2c9Kiavx5pbWc2dmzhL7vFp11sLgMcKFfSueq8haAh"; }],
    ["wrong mint pair", (p: Raw) => { p.token_y.address = "So11111111111111111111111111111111111111112"; }],
    ["swapped X/Y order", (p: Raw) => { [p.token_x, p.token_y] = [p.token_y, p.token_x]; }],
    ["same mint twice", (p: Raw) => { p.token_y.address = CBBTC_MINT; }],
    ["blacklisted", (p: Raw) => { p.is_blacklisted = true; }],
    ["missing blacklist flag", (p: Raw) => { delete p.is_blacklisted; }],
    ["different bin step", (p: Raw) => { p.pool_config.bin_step = 10; }],
    ["missing base fee", (p: Raw) => { delete p.pool_config.base_fee_pct; }],
    ["out-of-range protocol fee", (p: Raw) => { p.pool_config.protocol_fee_pct = 150; }],
    ["missing decimals", (p: Raw) => { delete p.token_x.decimals; }],
  ])("rejects %s", (_name, mutate) => {
    const pool = raw();
    mutate(pool);
    expect(parseMeteoraPool(pool)).toBeNull();
  });

  it("rejects non-objects", () => {
    for (const value of [null, undefined, "x", 1, []]) expect(parseMeteoraPool(value)).toBeNull();
  });

  it("falls back to the configured protocol share when protocol_fees is missing, and never goes negative", () => {
    const pool = raw();
    delete pool.protocol_fees;
    expect(parseMeteoraPool(pool)!.lpFees24hUsd).toBeCloseTo(4.247998606572472 * 0.95, 9);
    const over = raw();
    over.protocol_fees!["24h"] = 99;
    expect(parseMeteoraPool(over)!.lpFees24hUsd).toBe(0);
  });

  it("flags configured rewards", () => {
    const pool = raw();
    pool.reward_mint_x = CBBTC_MINT;
    expect(parseMeteoraPool(pool)!.hasRewards).toBe(true);
  });
});

describe("fetchMeteoraPools", () => {
  it("GETs each allowlisted pool from the Meteora datapi (read-only)", async () => {
    const fetcher = vi.fn(async () => Response.json(fixture));
    const pools = await fetchMeteoraPools({ fetcher: fetcher as unknown as typeof fetch });
    expect(pools.map(pool => pool.poolAddress)).toEqual([POOL]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${METEORA_DLMM_DATAPI}/pools/${POOL}`);
    expect(init.method ?? "GET").toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("skips failed or gated pools and ignores non-allowlisted ids", async () => {
    expect(await fetchMeteoraPools({ fetcher: (async () => new Response("no", { status: 503 })) as typeof fetch })).toEqual([]);
    expect(await fetchMeteoraPools({ fetcher: (async () => { throw new Error("down"); }) as typeof fetch })).toEqual([]);
    expect(await fetchMeteoraPools({ fetcher: (async () => Response.json({ ...fixture, is_blacklisted: true })) as typeof fetch })).toEqual([]);
    const fetcher = vi.fn(async () => Response.json(fixture));
    expect(await fetchMeteoraPools({ fetcher: fetcher as unknown as typeof fetch, poolAddresses: ["8k2c9Kiavx5pbWc2dmzhL7vFp11sLgMcKFfSueq8haAh"] })).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("propagates caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(fetchMeteoraPools({ signal: controller.signal, fetcher: (async (_u: string, init?: RequestInit) => {
      init?.signal?.throwIfAborted(); return Response.json(fixture);
    }) as typeof fetch })).rejects.toThrow();
  });
});

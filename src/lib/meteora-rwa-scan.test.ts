import type { Connection } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: () => ({}) }));
const ext = vi.hoisted(() => ({
  mintReads: 0,
  xstocks: new Set<string>(),
  tags: new Map<string, string[]>(),
  safety: new Map<string, { freezeAuthority: boolean; blockReasons: string[]; scaledUiKnown?: true; scaledUiConfig?: { multiplier: number; newMultiplier: number } }>(),
}));
vi.mock("./rwa-xstocks-whitelist", () => ({ fetchXstocksSolanaMintSet: async () => ext.xstocks, getXstocksObservedAt: () => "2026-11-01T00:00:00Z" }));
vi.mock("./rwa-jupiter-tags", () => ({
  fetchJupiterTagsByMint: async (mints: string[]) => new Map(mints.flatMap((mint) => (ext.tags.has(mint) ? [[mint, ext.tags.get(mint)!]] : []))),
  getJupiterTagsObservedAt: () => "2026-11-01T00:00:00Z",
}));
vi.mock("./onchain-mint-freeze", () => ({
  readMintSafety: async (_c: unknown, mints: string[]) => {
    ext.mintReads += 1;
    return new Map(mints.flatMap((m) => (ext.safety.has(m) ? [[m, ext.safety.get(m)!]] : [])));
  },
  readMintFreezeAuthorities: async () => new Map(),
}));

import { discoverMeteoraRwaPairs, METEORA_SCAN_MIN_TVL_USD, scanPageCounts } from "./meteora-rwa-scan";
import { CBBTC_MINT, HSOL_MINT, NATIVE_SOL_MINT, USDC_MINT, USDT_MINT, WBTC_PORTAL_MINT } from "./rwa-allowlist";
import { CBBTC_WBTC_DLMM_POOL_ID, SOL_HSOL_DLMM_POOL_ID } from "@sofinance/engine/protocols/meteora/constants";

const MSTRX = "MstrX11111111111111111111111111111111111111", MSTR = "Mstr111111111111111111111111111111111111111";
const TSLAX = "TsLaX11111111111111111111111111111111111111", TSLA = "TsLa111111111111111111111111111111111111111";
const NVDAX = "NvdaX11111111111111111111111111111111111111", SOL = "PxTsLaHuge111111111111111111111111111111111";
const SKHY = "Skhy111111111111111111111111111111111111111";

function pool(address: string, x: [string, string, string], y: [string, string, string], binStep: number, tvl: number) {
  const token = ([mint, symbol, name]: [string, string, string]) => ({ address: mint, symbol, name, decimals: 8, freeze_authority_disabled: true });
  return { address, name: `${x[1]}-${y[1]}`, token_x: token(x), token_y: token(y), reserve_x: "rx", reserve_y: "ry",
    created_at: 1_760_000_000_000, pool_config: { bin_step: binStep, base_fee_pct: binStep / 100, protocol_fee_pct: 5 },
    dynamic_fee_pct: 0, tvl, current_price: 1, volume: { "24h": tvl }, fees: { "24h": tvl / 1000 }, protocol_fees: { "24h": tvl / 20_000 },
    is_blacklisted: false, reward_mint_x: "", reward_mint_y: "" };
}
const MSTR_X = ([MSTRX, "MSTRx", "MicroStrategy xStock"] as [string, string, string]);
const MSTR_P = ([MSTR, "MSTR", "Strategy - Backpack Securities"] as [string, string, string]);
const POOLS = [
  pool("PxMstrTen11111111111111111111111111111111111", MSTR_X, MSTR_P, 10, 50_000),
  pool("PxMstrFive1111111111111111111111111111111111", MSTR_P, MSTR_X, 5, 9_000),
  pool("PxTsLaEight111111111111111111111111111111111", [TSLAX, "TSLAx", "Tesla xStock"], [TSLA, "TSLA", "Tesla - Backpack Securities"], 8, 20_000),
  pool("PxMstrTwenty11111111111111111111111111111111", MSTR_X, MSTR_P, 20, 80_000), // bin step above 10: counted, not listed
  pool("PxMstrDust1111111111111111111111111111111111", MSTR_X, MSTR_P, 1, 900), // under $5k
  pool("PxNvdaSoL11111111111111111111111111111111111", [NVDAX, "NVDAx", "NVIDIA xStock"], [SOL, "SOL", "Wrapped SOL"], 10, 500_000), // not same-asset
  pool("PxSkhyUsdc1111111111111111111111111111111111", [SKHY, "SKHY", "SK hynix"], [USDC_MINT, "USDC", "USD Coin"], 10, 100_000), // not same-asset
];

function datapi(pools: unknown[], options: { status?: number; pages?: number } = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (options.status) return new Response("", { status: options.status });
    const byId = url.pathname.match(/\/pools\/([^/]+)$/);
    if (byId && !url.searchParams.get("query") && !url.searchParams.get("filter_by")) {
      const found = pools.find((item) => (item as { address: string }).address === decodeURIComponent(byId[1]!));
      return found ? Response.json(found) : new Response("", { status: 404 });
    }
    const page = Number(url.searchParams.get("page"));
    const pages = options.pages ?? 1;
    const query = url.searchParams.get("query");
    if (query !== null) {
      const hits = pools.filter((p) => JSON.stringify(p).includes(query));
      return Response.json({ total: hits.length * pages, pages, current_page: page, page_size: 1000, data: hits });
    }
    const filter = url.searchParams.get("filter_by")!; // e.g. token_x=<mint>&&is_blacklisted=false
    const [side, rest] = filter.split("=") as ["token_x" | "token_y", string];
    const mint = rest.split("&&")[0];
    const hits = pools.filter((p) => (p as Record<string, { address: string }>)[side]!.address === mint);
    return Response.json({ total: hits.length * pages, pages, current_page: page, page_size: 1000, data: hits });
  });
}

afterEach(() => { ext.xstocks = new Set(); ext.tags = new Map(); ext.safety = new Map(); ext.mintReads = 0; });
function tagged() {
  ext.xstocks = new Set([MSTRX, TSLAX, NVDAX]);
  ext.tags = new Map([[MSTR, ["stocks"]], [TSLA, ["stocks"]], [MSTRX, ["stocks", "xstocks"]], [TSLAX, ["stocks", "xstocks"]]]);
}

describe("Meteora DLMM RWA scan", () => {
  it("lists only same-asset pools with bin step ≤ 10 and TVL ≥ $5k, and counts what it left out", async () => {
    tagged();
    const fetcher = datapi(POOLS);
    const result = await discoverMeteoraRwaPairs({ fetcher: fetcher as unknown as typeof fetch, connection: null, minTvl: METEORA_SCAN_MIN_TVL_USD,
      seedMints: [MSTR, SKHY, USDC_MINT], sortBy: "tvl" });
    expect(result.pairs.map((p) => p.poolAddress)).toEqual(["PxMstrTen11111111111111111111111111111111111", "PxTsLaEight111111111111111111111111111111111", "PxMstrFive1111111111111111111111111111111111"]);
    expect(result.pairs.every((p) => p.protocol === "meteora-dlmm")).toBe(true);
    expect(result.pairs[0]).toMatchObject({ binStep: 10, baseSymbol: "MSTR", wrapKind: "suffix-x", poolCreatedAt: "2025-10-09T08:53:20.000Z" });
    // One `xStock` search covers the xStocks mints; USDC is never a seed; MSTR + SKHY are asked by mint, two sides each.
    expect(result.meteora).toMatchObject({ seedMints: 2, queries: 5, xstocksQueryPools: 6, scannedPools: 7, sameAssetPools: 5, excludedBinStep: 1, truncatedSeeds: 0 });
    expect(fetcher.mock.calls.some(([url]) => String(url).includes(USDC_MINT))).toBe(false);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes(MSTRX))).toBe(false);
    expect(String(fetcher.mock.calls[0]![0])).toContain("/pools?query=xStock&filter_by=is_blacklisted=false&page_size=1000&page=1");
    expect(String(fetcher.mock.calls[1]![0])).toContain("%26%26is_blacklisted=false&page_size=1000&page=1");
    // One generation: every row on page 1, page counts sum to the scanned pools.
    expect(Object.values(result.discovery!.sourcePages)).toEqual([1, 1, 1]);
    expect(result.discovery!.pageCounts.reduce((a, b) => a + b, 0)).toBe(result.scannedPools);
  });

  it("needs both mints qualified: an untagged plain token is not listed", async () => {
    tagged();
    ext.tags.delete(TSLA);
    const result = await discoverMeteoraRwaPairs({ fetcher: datapi(POOLS) as unknown as typeof fetch, connection: null, minTvl: 5_000 });
    expect(result.pairs.map((p) => p.poolAddress)).not.toContain("PxTsLaEight111111111111111111111111111111111");
  });

  it("throws on a datapi 429 or a malformed list, so a partial scan is never published", async () => {
    tagged();
    await expect(discoverMeteoraRwaPairs({ fetcher: datapi(POOLS, { status: 429 }) as unknown as typeof fetch, connection: null }))
      .rejects.toMatchObject({ name: "MeteoraPoolListError", status: 429 });
    const malformed = vi.fn(async () => Response.json({ data: "nope" }));
    await expect(discoverMeteoraRwaPairs({ fetcher: malformed as unknown as typeof fetch, connection: null }))
      .rejects.toMatchObject({ status: "malformed" });
  });

  it("follows pages up to the cap and flags a seed whose pools were cut off", async () => {
    tagged();
    const fetcher = datapi(POOLS, { pages: 5 });
    const result = await discoverMeteoraRwaPairs({ fetcher: fetcher as unknown as typeof fetch, connection: null, minTvl: 5_000 });
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("query=xStock")).map(([url]) => new URL(String(url)).searchParams.get("page")))
      .toEqual(["1", "2", "3"]);
    expect(result.meteora.truncatedSeeds).toBeGreaterThan(0);
  });

  it("lists USDC/USDT only from the curated stable allowlist (empty by default, the Raydium rule)", async () => {
    tagged();
    const stable = pool("PxUsdcUsdt1111111111111111111111111111111111", [USDC_MINT, "USDC", "USD Coin"], [USDT_MINT, "USDT", "USDT"], 1, 1_000_000);
    const fetcher = datapi([...POOLS, stable]);
    const off = await discoverMeteoraRwaPairs({ fetcher: fetcher as unknown as typeof fetch, connection: null, minTvl: 5_000 });
    expect(off.pairs.map((p) => p.poolAddress)).not.toContain("PxUsdcUsdt1111111111111111111111111111111111");
    const byId = vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith("/pools/PxUsdcUsdt1111111111111111111111111111111111") ? Response.json(stable) : fetcher(input)));
    const on = await discoverMeteoraRwaPairs({ fetcher: byId as unknown as typeof fetch, connection: null, minTvl: 5_000,
      stablePools: [{ poolAddress: "PxUsdcUsdt1111111111111111111111111111111111", mintX: USDC_MINT, mintY: USDT_MINT, binStep: 1 }] });
    expect(on.pairs.find((p) => p.poolAddress === "PxUsdcUsdt1111111111111111111111111111111111")).toMatchObject({ baseSymbol: "USD" });
  });

  it("applies the shared Token-2022 block and freeze read from chain (blocked rows kept, counted)", async () => {
    tagged();
    ext.safety = new Map([[TSLAX, { freezeAuthority: true, blockReasons: ["transfer-fee"] }], [TSLA, { freezeAuthority: false, blockReasons: [] }]]);
    const connection = { getMultipleAccountsInfo: async (keys: unknown[]) => keys.map(() => null) } as unknown as Connection;
    const result = await discoverMeteoraRwaPairs({ fetcher: datapi(POOLS) as unknown as typeof fetch, connection, minTvl: 5_000 });
    const tsla = result.pairs.find((p) => p.poolAddress === "PxTsLaEight111111111111111111111111111111111")!;
    expect(tsla.blocked).toBeTruthy();
    expect(tsla).toMatchObject({ freezeRiskA: true, freezeRiskB: false });
    expect(result.meteora).toMatchObject({ blocked: 1, onchainVerified: 0 });
  });

  it("runs the $5k floor again on the registry-unit TVL: a m < 1 pool corrected under it is not listed; unverified keeps the published value (X3-7)", async () => {
    tagged();
    // datapi: $6,000 = 30 TSLAx × $100/share + 30 TSLA × $100. With TSLAx at ×0.5 the pool holds $4,500 (6,000 + 30 × (0.5 − 1) × 100).
    const half = pool("PxTsLaHalf11111111111111111111111111111111111", [TSLAX, "TSLAx", "Tesla xStock"], [TSLA, "TSLA", "Tesla - Backpack Securities"], 8, 6_000);
    const withSides = { ...half, token_x_amount: 30, token_y_amount: 30, token_x: { ...half.token_x, price: 100 }, token_y: { ...half.token_y, price: 100 } };
    const connection = { getMultipleAccountsInfo: async (keys: unknown[]) => keys.map(() => null) } as unknown as Connection;
    const scan = () => discoverMeteoraRwaPairs({ fetcher: datapi([...POOLS, withSides]) as unknown as typeof fetch, connection, minTvl: METEORA_SCAN_MIN_TVL_USD });

    ext.safety = new Map([
      [TSLAX, { freezeAuthority: false, blockReasons: [], scaledUiKnown: true, scaledUiConfig: { multiplier: 0.5, newMultiplier: 0.5 } }],
      [TSLA, { freezeAuthority: false, blockReasons: [], scaledUiKnown: true }],
    ]);
    const corrected = await scan();
    expect(corrected.pairs.map((p) => p.poolAddress)).not.toContain("PxTsLaHalf11111111111111111111111111111111111");
    // The ×1 pools around it are corrected to their own value and stay listed.
    expect(corrected.pairs.find((p) => p.poolAddress === "PxMstrTen11111111111111111111111111111111111")).toBeDefined();

    // Mints not read: the pool is listed at datapi's figure, marked unverified, never shown as corrected.
    ext.safety = new Map();
    const unread = await scan();
    const row = unread.pairs.find((p) => p.poolAddress === "PxTsLaHalf11111111111111111111111111111111111")!;
    expect(row.tvlUsd).toBe(6_000);
    expect(row.tvlScaledUi).toMatchObject({ status: "unverified", sourceTvlUsd: 6_000, mintsRead: false });
  });

  it("reads the mints before the $5k floor: a ×8 pool under the floor on datapi's figure is listed at its corrected TVL, one mint read (X3-8)", async () => {
    tagged();
    // datapi: $1,000 = 5 TSLAx × $100/share + 5 TSLA × $100. TSLAx ×8: the pool holds 1,000 + 5 × (8 − 1) × 100 = $4,500, under $5k;
    // 10 + 10 tokens: datapi $2,000, corrected $9,000, over it.
    const scaled = (address: string, amount: number) => {
      const base = pool(address, [TSLAX, "TSLAx", "Tesla xStock"], [TSLA, "TSLA", "Tesla - Backpack Securities"], 8, amount * 200);
      return { ...base, token_x_amount: amount, token_y_amount: amount, token_x: { ...base.token_x, price: 100 }, token_y: { ...base.token_y, price: 100 } };
    };
    const small = scaled("PxTsLaTiny111111111111111111111111111111111", 5), big = scaled("PxTsLaHuge111111111111111111111111111111111", 10);
    ext.safety = new Map([
      [TSLAX, { freezeAuthority: false, blockReasons: [], scaledUiKnown: true, scaledUiConfig: { multiplier: 8, newMultiplier: 8 } }],
      [TSLA, { freezeAuthority: false, blockReasons: [], scaledUiKnown: true }],
    ]);
    const connection = { getMultipleAccountsInfo: async (keys: unknown[]) => keys.map(() => null) } as unknown as Connection;
    // Valid addresses (the shared POOLS fixtures are not base58 keys, so their LbPair read throws and the scan falls back).
    const dust = pool("PxTsLaDust111111111111111111111111111111111", [TSLAX, "TSLAx", "Tesla xStock"], [TSLA, "TSLA", "Tesla - Backpack Securities"], 8, 100);
    const result = await discoverMeteoraRwaPairs({ fetcher: datapi([small, big, dust]) as unknown as typeof fetch, connection, minTvl: METEORA_SCAN_MIN_TVL_USD });
    const listed = result.pairs.map((p) => p.poolAddress);
    expect(listed).toContain("PxTsLaHuge111111111111111111111111111111111");
    expect(listed).not.toContain("PxTsLaTiny111111111111111111111111111111111");
    expect(result.pairs.find((p) => p.poolAddress === "PxTsLaHuge111111111111111111111111111111111")).toMatchObject({
      tvlUsd: 9_000, tvlScaledUi: { status: "corrected", sourceTvlUsd: 2_000, mintsRead: true } });
    // A pool without token amounts stays at datapi's figure and is still under the floor: the floor is moved, never skipped.
    expect(listed).not.toContain("PxTsLaDust111111111111111111111111111111111");
    // One mint read serves the facts and the freeze / multiplier step (no second read).
    expect(ext.mintReads).toBe(1);
  });

  it("without a chain read the floor uses datapi's figure, as before (X3-8)", async () => {
    tagged();
    const result = await discoverMeteoraRwaPairs({ fetcher: datapi(POOLS) as unknown as typeof fetch, connection: null, minTvl: METEORA_SCAN_MIN_TVL_USD });
    expect(result.pairs.map((p) => p.poolAddress)).not.toContain("PxMstrDust1111111111111111111111111111111111");
    expect(ext.mintReads).toBe(0);
  });

  it("page counts split scanned pools into ≤ 1000-row pages (store schema)", () => {
    expect(scanPageCounts(0)).toEqual([0]);
    expect(scanPageCounts(2_500)).toEqual([1000, 1000, 500]);
  });

  it("lists the curated SOL/hSOL LST pool even when its TVL is under the $5k scan floor", async () => {
    tagged();
    const lst = pool(SOL_HSOL_DLMM_POOL_ID, [HSOL_MINT, "hSOL", "Helius Staked SOL"], [NATIVE_SOL_MINT, "WSOL", "Wrapped SOL"], 1, 4_000);
    const result = await discoverMeteoraRwaPairs({ fetcher: datapi([...POOLS, lst]) as unknown as typeof fetch, connection: null, minTvl: 5_000 });
    const row = result.pairs.find((item) => item.poolAddress === SOL_HSOL_DLMM_POOL_ID);
    expect(row).toMatchObject({ wrapKind: "lst", baseSymbol: "SOL", wrappedSymbol: "SOL", plainSymbol: "hSOL", symbolA: "hSOL", symbolB: "SOL", tvlUsd: 4_000 });
  });
  it("lists the curated cbBTC/WBTC pool as a same-asset BTC pair with no fair price, even under the TVL floor", async () => {
    tagged();
    const btc = pool(CBBTC_WBTC_DLMM_POOL_ID, [CBBTC_MINT, "cbBTC", "Coinbase Wrapped BTC"], [WBTC_PORTAL_MINT, "WBTC", "Wrapped BTC (Portal)"], 1, 4_000);
    const fetcher = datapi([...POOLS, btc]);
    const result = await discoverMeteoraRwaPairs({
      fetcher: fetcher as unknown as typeof fetch, connection: null, minTvl: 5_000, seedMints: [MSTR, CBBTC_MINT, WBTC_PORTAL_MINT],
    });
    const row = result.pairs.find((item) => item.poolAddress === CBBTC_WBTC_DLMM_POOL_ID);
    expect(row).toMatchObject({
      protocol: "meteora-dlmm", wrapKind: "same-asset", relatedness: "allowlisted", baseSymbol: "BTC",
      wrappedSymbol: "cbBTC", plainSymbol: "WBTC", symbolA: "cbBTC", symbolB: "WBTC", mintA: CBBTC_MINT, mintB: WBTC_PORTAL_MINT, binStep: 1, tvlUsd: 4_000,
    });
    expect(row!.fairPriceBPerA).toBeUndefined();
    expect(row!.lstSolPerHsol).toBeUndefined();
    // The curated mints are fetched by pool id only: never asked as scan seeds.
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("filter_by=token_x=" + CBBTC_MINT))).toBe(false);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("filter_by=token_y=" + WBTC_PORTAL_MINT))).toBe(false);
  });

  it("drops the curated cbBTC/WBTC pool when datapi reports other mints or a wider bin step for its id", async () => {
    tagged();
    const nativeWbtc = "5XZw2LKTyrfvfiskJ78AMpackRjPcyCif1WhUsPDuVqQ";
    const otherMint = pool(CBBTC_WBTC_DLMM_POOL_ID, [CBBTC_MINT, "cbBTC", "Coinbase Wrapped BTC"], [nativeWbtc, "WBTC", "Wrapped BTC"], 1, 300_000);
    const wideBin = pool(CBBTC_WBTC_DLMM_POOL_ID, [CBBTC_MINT, "cbBTC", "Coinbase Wrapped BTC"], [WBTC_PORTAL_MINT, "WBTC", "Wrapped BTC (Portal)"], 20, 300_000);
    for (const bad of [otherMint, wideBin]) {
      const result = await discoverMeteoraRwaPairs({ fetcher: datapi([...POOLS, bad]) as unknown as typeof fetch, connection: null, minTvl: 5_000 });
      expect(result.pairs.map((item) => item.poolAddress)).not.toContain(CBBTC_WBTC_DLMM_POOL_ID);
    }
  });
});

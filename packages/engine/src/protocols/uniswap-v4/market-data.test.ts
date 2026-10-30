import { describe, expect, it } from "vitest";
import dexScreenerCapture from "../../fixtures/univ4-rhc-spcx-dexscreener.json";
import geckoCapture from "../../fixtures/univ4-rhc-spcx-geckoterminal.json";
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "./constants";
import {
  dexScreenerPairsUrl, dexScreenerPairUrl, fetchUniv4MarketData, geckoTerminalPoolsMultiUrl, geckoTerminalPoolUrl,
  parseDexScreenerPair, parseDexScreenerPairs, parseGeckoTerminalPool, parseGeckoTerminalPools, poolAprFromMarket,
} from "./market-data";

const SPCX = UNIV4_RHC_ALLOWLISTED_POOLS[0]!;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("uniswap-v4-rhc market data (DexScreener / GeckoTerminal captures, 2026-10-29)", () => {
  it("parses the DexScreener v4 pair keyed by poolId and maps base/quote to token0/token1", () => {
    expect(parseDexScreenerPair(dexScreenerCapture, SPCX)).toEqual({
      source: "dexscreener", volume24hUsd: 36.54, tvlUsd: 48711.43, txns24h: 3,
      // DexScreener's base is SPCXon (token1), quote SPCX (token0).
      reserves: { token0: 166.5943, token1: 172.2797 },
      // priceUsd is SPCXon's (base) USD price; SPCX's comes from priceNative (quote per base).
      priceUsd: { token0: 143.74 / 1.0000003527, token1: 143.74 },
    });
  });

  it("reads token USD prices (stock tokens trade at the share price, not $1)", () => {
    // GeckoTerminal's base is SPCXon (token1), quote SPCX (token0).
    expect(parseGeckoTerminalPool(geckoCapture, SPCX)?.priceUsd).toEqual({ token0: 144.702839920411, token1: 144.710103947608 });
    const noPrice = structuredClone(geckoCapture) as { data: { attributes: Record<string, unknown> } };
    noPrice.data.attributes.quote_token_price_usd = null;
    expect(parseGeckoTerminalPool(noPrice, SPCX)?.priceUsd).toBeNull();
  });

  it("parses the GeckoTerminal pool", () => {
    expect(parseGeckoTerminalPool(geckoCapture, SPCX)).toMatchObject({ source: "geckoterminal", volume24hUsd: 36.6876105419, tvlUsd: 48127.55, txns24h: 3 });
  });

  it("rejects payloads for another pool, chain or token pair", () => {
    const other = structuredClone(dexScreenerCapture) as { pair: { chainId: string; pairAddress: string; baseToken: { address: string } }; pairs: unknown[] };
    other.pairs = [];
    other.pair.chainId = "ethereum";
    expect(parseDexScreenerPair(other, SPCX)).toBeNull();
    other.pair.chainId = "robinhood";
    other.pair.baseToken.address = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
    expect(parseDexScreenerPair(other, SPCX)).toBeNull();
    const gecko = structuredClone(geckoCapture) as { data: { id: string } };
    gecko.data.id = "robinhood_0xdead";
    expect(parseGeckoTerminalPool(gecko, SPCX)).toBeNull();
    expect(parseDexScreenerPair({ pairs: null, pair: null }, SPCX)).toBeNull();
  });

  it("uses DexScreener first and GeckoTerminal only when DexScreener fails or rate-limits", async () => {
    const hits: string[] = [];
    const events: string[] = [];
    const fetcher = (async (url: string) => {
      hits.push(url);
      return url === dexScreenerPairUrl(SPCX.poolId) ? json({ error: "busy" }, 429) : json(geckoCapture);
    }) as unknown as typeof fetch;
    const market = await fetchUniv4MarketData(SPCX, { fetcher, onUpstream: event => events.push(`${event.source}:${event.outcome}`) });
    expect(market?.source).toBe("geckoterminal");
    expect(hits).toEqual([dexScreenerPairUrl(SPCX.poolId), geckoTerminalPoolUrl(SPCX.poolId)]);
    expect(events).toEqual(["dexscreener:rate-limited", "geckoterminal:ok"]);

    hits.length = 0;
    const primary = await fetchUniv4MarketData(SPCX, { fetcher: (async (url: string) => { hits.push(url); return json(dexScreenerCapture); }) as unknown as typeof fetch });
    expect(primary?.source).toBe("dexscreener");
    expect(hits).toHaveLength(1);
  });

  it("returns null (never throws) when both fail, and honours a closed fallback gate", async () => {
    const failing = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    expect(await fetchUniv4MarketData(SPCX, { fetcher: failing })).toBeNull();
    const hits: string[] = [];
    const counting = (async (url: string) => { hits.push(url); return json({}, 500); }) as unknown as typeof fetch;
    expect(await fetchUniv4MarketData(SPCX, { fetcher: counting, allowFallback: () => false })).toBeNull();
    expect(hits).toEqual([dexScreenerPairUrl(SPCX.poolId)]);
  });

  it("APR = fee rate × 24h volume / TVL × 365", () => {
    const apr = poolAprFromMarket({ source: "dexscreener", volume24hUsd: 1_000_000, tvlUsd: 2_000_000, txns24h: null, reserves: null }, { zeroForOne: 50, oneForZero: 50 });
    expect(apr).toMatchObject({ estimated: true, label: { zh: "估計", en: "Estimated" } });
    expect(apr.feeRatePct).toBeCloseTo(0.005, 12);
    expect(apr.estimatedPoolFeeAprPct).toBeCloseTo(0.00005 * 0.5 * 365 * 100, 9);
    expect(poolAprFromMarket({ source: "dexscreener", volume24hUsd: 1, tvlUsd: 0, txns24h: null, reserves: null }, { zeroForOne: 50, oneForZero: 50 }).estimatedPoolFeeAprPct).toBeNull();
  });

  it("attribution only when GeckoTerminal data is shown (PM, 2026-10-29)", () => {
    const fee = { zeroForOne: 50, oneForZero: 50 };
    expect(poolAprFromMarket({ source: "dexscreener", volume24hUsd: 1, tvlUsd: 1, txns24h: null, reserves: null }, fee).attribution).toBeNull();
    expect(poolAprFromMarket({ source: "geckoterminal", volume24hUsd: 1, tvlUsd: 1, txns24h: null, reserves: null }, fee).attribution)
      .toEqual({ text: "Data: GeckoTerminal", url: "https://www.geckoterminal.com" });
  });
});

describe("uniswap-v4-rhc batched market data (cron: one call for every pool)", () => {
  it("builds one GeckoTerminal pools/multi and one DexScreener pairs URL for all ids", () => {
    const ids = UNIV4_RHC_ALLOWLISTED_POOLS.map((pool) => pool.poolId);
    const multi = geckoTerminalPoolsMultiUrl(ids);
    expect(multi.startsWith("https://api.geckoterminal.com/api/v2/networks/robinhood/pools/multi/")).toBe(true);
    expect(multi.split("/").at(-1)!.split(",")).toEqual(ids.map((id) => id.toLowerCase()));
    expect(dexScreenerPairsUrl(ids.slice(0, 2)).split("/").at(-1)).toBe(ids.slice(0, 2).map((id) => id.toLowerCase()).join(","));
  });

  it("maps a pools/multi list back to each allowlisted pool and leaves missing pools out", () => {
    const item = (geckoCapture as { data: unknown }).data;
    const parsed = parseGeckoTerminalPools({ data: [item] }, UNIV4_RHC_ALLOWLISTED_POOLS);
    expect([...parsed.keys()]).toEqual([SPCX.poolId.toLowerCase()]);
    expect(parsed.get(SPCX.poolId.toLowerCase())).toMatchObject({ source: "geckoterminal", tvlUsd: 48127.55 });
    expect(parseGeckoTerminalPools({ data: "nope" }, UNIV4_RHC_ALLOWLISTED_POOLS).size).toBe(0);
    expect(parseGeckoTerminalPools(null, UNIV4_RHC_ALLOWLISTED_POOLS).size).toBe(0);
  });

  it("maps a DexScreener multi-pair payload per pool", () => {
    const parsed = parseDexScreenerPairs(dexScreenerCapture, UNIV4_RHC_ALLOWLISTED_POOLS);
    expect([...parsed.keys()]).toEqual([SPCX.poolId.toLowerCase()]);
    expect(parsed.get(SPCX.poolId.toLowerCase())).toMatchObject({ source: "dexscreener", tvlUsd: 48711.43 });
  });
});

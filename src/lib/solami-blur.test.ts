import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  blurSubscribeFilter,
  eventMatchesPool,
  filterTradesForPool,
  getPoolActivitySnapshot,
  isBlurConfigured,
  parseBlurPoolSnapshot,
  parseBlurTrade,
  parseBlurTradeList,
  parseDecimal,
} from "./solami-blur";

const POOL = "DUzBLHZ5RZdftPuWVijsvjupndogRM1adGJpsR7YTJro";

const poolFixture = {
  pool: POOL,
  dex: "raydium_clmm",
  mint: "mintA1111111111111111111111111111111111111",
  quote_mint: "mintB111111111111111111111111111111111111",
  name: "SPCXx / SPCX",
  symbol: "SPCXx/SPCX",
  price: "1.0025",
  price_usd: "1.00",
  base_reserve: "1000",
  quote_reserve: "1002",
  liquidity_usd: "50000",
  tvl_usd: "50000",
  fees_24h_usd: "12.5",
  volume_tvl_ratio: "0.08",
  lp_deposit_24h_usd: "100",
  lp_withdraw_24h_usd: "40",
};

const tradeFixture = {
  signature: "5".repeat(88),
  slot: 123,
  block_time: 1_700_000_000,
  dex: "raydium_clmm",
  pool: POOL,
  side: "buy",
  trader: "11111111111111111111111111111111",
  price: "1.0025",
  price_usd: "1.00",
  volume_usd: "250.5",
  base_amount: "10",
  quote_amount: "10.025",
};

describe("isBlurConfigured", () => {
  it("is off without a data key and on when one is set", () => {
    expect(isBlurConfigured({})).toBe(false);
    expect(isBlurConfigured({ SOLAMI_DATA_API_KEY: "  " })).toBe(false);
    expect(isBlurConfigured({ SOLAMI_DATA_API_KEY: "k" })).toBe(true);
  });
});

describe("parseBlurPoolSnapshot", () => {
  it("reads the verified /data/pool field names, including decimal strings", () => {
    const parsed = parseBlurPoolSnapshot(poolFixture);
    expect(parsed).toMatchObject({
      pool: POOL,
      dex: "raydium_clmm",
      price: 1.0025,
      tvlUsd: 50_000,
      fees24hUsd: 12.5,
      lpDeposit24hUsd: 100,
    });
  });

  it("accepts a { data } envelope and camelCase aliases", () => {
    const parsed = parseBlurPoolSnapshot({
      data: { pool: POOL, quoteMint: "Q", priceUsd: 2, liquidityUsd: 3 },
    });
    expect(parsed?.quoteMint).toBe("Q");
    expect(parsed?.priceUsd).toBe(2);
    expect(parsed?.liquidityUsd).toBe(3);
  });

  it("returns null without a pool address", () => {
    expect(parseBlurPoolSnapshot({ price: 1 })).toBeNull();
    expect(parseBlurPoolSnapshot(null)).toBeNull();
  });
});

describe("parseBlurTrade / parseBlurTradeList", () => {
  it("reads the verified /data/trades/recent fields", () => {
    expect(parseBlurTrade(tradeFixture)).toMatchObject({
      signature: tradeFixture.signature,
      pool: POOL,
      side: "buy",
      volumeUsd: 250.5,
      type: "swap",
    });
  });

  it("filters a firehose page down to one pool", () => {
    const list = parseBlurTradeList([
      tradeFixture,
      { ...tradeFixture, signature: "4".repeat(88), pool: "other" },
    ]);
    expect(filterTradesForPool(list, POOL)).toHaveLength(1);
  });

  it("ignores rows without a signature", () => {
    expect(parseBlurTrade({ pool: POOL, price: 1 })).toBeNull();
  });
});

describe("blurSubscribeFilter / eventMatchesPool", () => {
  it("asks the socket for swap+liquidity on the pool", () => {
    expect(blurSubscribeFilter(POOL)).toEqual({
      filter: { types: ["swap", "liquidity"], pools: [POOL], addresses: [POOL] },
    });
  });

  it("matches live events by pool or address", () => {
    expect(eventMatchesPool({ type: "swap", pool: POOL }, POOL)).toBe(true);
    expect(eventMatchesPool({ type: "liquidity", address: POOL }, POOL)).toBe(true);
    expect(eventMatchesPool({ type: "swap", pool: "other" }, POOL)).toBe(false);
  });
});

describe("getPoolActivitySnapshot", () => {
  it("hides Blur features when no data key is set", async () => {
    const snapshot = await getPoolActivitySnapshot(POOL, { env: {} });
    expect(snapshot.available).toBe(false);
    expect(snapshot.source).toBe("unavailable");
    expect(snapshot.trades).toEqual([]);
  });

  it("loads pool stats and pool-filtered trades", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/pool?")) {
        return new Response(JSON.stringify(poolFixture), { status: 200 });
      }
      return new Response(JSON.stringify([tradeFixture, { ...tradeFixture, pool: "x", signature: "4".repeat(88) }]), {
        status: 200,
      });
    });
    const snapshot = await getPoolActivitySnapshot(POOL, {
      env: { SOLAMI_DATA_API_KEY: "test-data-key" },
      fetcher,
      limit: 10,
    });
    expect(snapshot.available).toBe(true);
    expect(snapshot.pool?.dex).toBe("raydium_clmm");
    expect(snapshot.trades).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ "x-api-key": "test-data-key" }),
      }),
    );
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain("test-data-key");
  });
});

describe("parseDecimal", () => {
  it("accepts numbers and numeric strings", () => {
    expect(parseDecimal(1.5)).toBe(1.5);
    expect(parseDecimal("2.25")).toBe(2.25);
    expect(parseDecimal("nope")).toBeNull();
  });
});

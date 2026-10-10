import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  blurEventDedupeKey,
  blurSubscribeFilter,
  blurWsUrl,
  dedupeBlurTrades,
  encodeSseEvent,
  eventMatchesPool,
  filterTradesForPool,
  formatSseComment,
  getPoolActivitySnapshot,
  isBlurConfigured,
  parseBlurLiveEvent,
  parseBlurPoolSnapshot,
  parseBlurTrade,
  parseBlurTradeList,
  parseDecimal,
  rememberBlurEvent,
  sseChunkLeaksSecret,
  tokenTradesFetchLimit,
} from "./solami-blur";

const POOL = "DUzBLHZ5RZdftPuWVijsvjupndogRM1adGJpsR7YTJro";
const MINT = "Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8";

const poolFixture = {
  pool: POOL,
  dex: "raydium_clmm",
  mint: MINT,
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
  ix_index: 2,
  inner_ix_index: 1,
};

const connectedFrame = {
  type: "connected",
  region: "nyc",
  filter: { types: ["swap", "liquidity"], mints: 0, pools: 1 },
};

const metadataFrame = {
  type: "metadata",
  image_url: `https://cdn.solami.dev/token.png?api_key=sk_live_secret_from_server`,
};

describe("isBlurConfigured", () => {
  it("is off without a data key and on when one is set", () => {
    expect(isBlurConfigured({})).toBe(false);
    expect(isBlurConfigured({ SOLAMI_DATA_API_KEY: "  " })).toBe(false);
    expect(isBlurConfigured({ SOLAMI_DATA_API_KEY: "k" })).toBe(true);
  });
});

describe("blurWsUrl", () => {
  it("filters by pool= and never treats the pool id as address= (mint filter)", () => {
    const url = blurWsUrl(POOL, { SOLAMI_DATA_API_KEY: "test-data-key" });
    expect(url).toContain(`pool=${POOL}`);
    expect(url).toContain("type=swap%2Cliquidity");
    expect(url).not.toContain("address=");
    expect(url).toContain("api_key=test-data-key");
  });

  it("is null without a data key", () => {
    expect(blurWsUrl(POOL, {})).toBeNull();
  });
});

describe("parseBlurPoolSnapshot", () => {
  it("reads the verified /data/pool field names, including mint", () => {
    const parsed = parseBlurPoolSnapshot(poolFixture);
    expect(parsed).toMatchObject({
      pool: POOL,
      dex: "raydium_clmm",
      mint: MINT,
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
  it("reads /data/token/trades fields including ix_index", () => {
    expect(parseBlurTrade(tradeFixture)).toMatchObject({
      signature: tradeFixture.signature,
      pool: POOL,
      side: "buy",
      volumeUsd: 250.5,
      type: "swap",
      ixIndex: 2,
      innerIxIndex: 1,
    });
  });

  it("filters a token-trades page down to one pool", () => {
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
  it("asks the socket for swap+liquidity on the pool (not as a mint address)", () => {
    expect(blurSubscribeFilter(POOL)).toEqual({
      filter: { types: ["swap", "liquidity"], pools: [POOL] },
    });
  });

  it("matches live events by pool only — address is a mint, not a pool id", () => {
    expect(eventMatchesPool({ type: "swap", pool: POOL }, POOL)).toBe(true);
    expect(eventMatchesPool({ type: "liquidity", address: POOL }, POOL)).toBe(false);
    expect(eventMatchesPool({ type: "swap", pool: "other" }, POOL)).toBe(false);
  });
});

describe("parseBlurLiveEvent / dual-side dedupe", () => {
  it("drops connected and metadata frames (metadata embeds api_key)", () => {
    expect(parseBlurLiveEvent(connectedFrame, POOL)).toBeNull();
    expect(parseBlurLiveEvent(metadataFrame, POOL)).toBeNull();
    expect(parseBlurLiveEvent({ type: "ping" }, POOL)).toBeNull();
  });

  it("accepts a swap and a liquidity event with a signature", () => {
    const swap = parseBlurLiveEvent({ ...tradeFixture, type: "swap" }, POOL);
    expect(swap?.kind).toBe("swap");
    expect(swap?.trade.signature).toBe(tradeFixture.signature);
    const liq = parseBlurLiveEvent({ ...tradeFixture, type: "liquidity", signature: "4".repeat(88) }, POOL);
    expect(liq?.kind).toBe("liquidity");
  });

  it("dedupes the two sides of one swap by signature+ix_index+inner_ix_index", () => {
    const buy = parseBlurTrade({ ...tradeFixture, mint: MINT, quote_mint: "Q", side: "buy" });
    const sell = parseBlurTrade({
      ...tradeFixture,
      mint: "Q",
      quote_mint: MINT,
      side: "sell",
      price: "0.9975",
    });
    expect(buy && sell).toBeTruthy();
    expect(blurEventDedupeKey(buy!)).toBe(blurEventDedupeKey(sell!));
    const seen = new Set<string>();
    expect(rememberBlurEvent(seen, buy!)).toBe(true);
    expect(rememberBlurEvent(seen, sell!)).toBe(false);
    expect(dedupeBlurTrades([buy!, sell!])).toHaveLength(1);
  });
});

describe("SSE encoding never leaks api_key / sk_", () => {
  it("encodes a parsed swap without secrets", () => {
    const trade = parseBlurTrade(tradeFixture);
    const chunk = encodeSseEvent("swap", trade);
    expect(chunk).toContain("event: swap");
    expect(sseChunkLeaksSecret(chunk!)).toBe(false);
    expect(chunk).not.toMatch(/api_key/i);
    expect(chunk).not.toMatch(/sk_/);
  });

  it("refuses to emit a raw metadata frame that embeds the server key", () => {
    expect(encodeSseEvent("metadata", metadataFrame)).toBeNull();
    expect(sseChunkLeaksSecret(JSON.stringify(metadataFrame))).toBe(true);
  });

  it("keeps heartbeat comments secret-free", () => {
    const comment = formatSseComment("heartbeat");
    expect(comment).toBe(": heartbeat\n\n");
    expect(sseChunkLeaksSecret(comment)).toBe(false);
  });

  it("a simulated upstream burst yields no api_key or sk_ in outgoing SSE", () => {
    const seen = new Set<string>();
    const outgoing: string[] = [];
    const frames: unknown[] = [
      connectedFrame,
      metadataFrame,
      { ...tradeFixture, type: "swap", mint: MINT, quote_mint: "Q" },
      { ...tradeFixture, type: "swap", mint: "Q", quote_mint: MINT, side: "sell" },
    ];
    for (const frame of frames) {
      const parsed = parseBlurLiveEvent(frame, POOL);
      if (!parsed) continue;
      if (!rememberBlurEvent(seen, parsed.trade)) continue;
      const chunk = encodeSseEvent(parsed.kind, parsed.trade);
      if (chunk) outgoing.push(chunk);
    }
    outgoing.push(formatSseComment("heartbeat"));
    const payload = outgoing.join("");
    expect(outgoing).toHaveLength(2);
    expect(payload).not.toMatch(/api_key/i);
    expect(payload).not.toMatch(/sk_/);
  });
});

describe("getPoolActivitySnapshot", () => {
  it("hides Blur features when no data key is set", async () => {
    const snapshot = await getPoolActivitySnapshot(POOL, { env: {} });
    expect(snapshot.available).toBe(false);
    expect(snapshot.source).toBe("unavailable");
    expect(snapshot.trades).toEqual([]);
  });

  it("loads /data/pool then /data/token/trades?address=<mint> and filters by pool", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/pool?")) {
        return new Response(JSON.stringify(poolFixture), { status: 200 });
      }
      if (url.includes("/token/trades?")) {
        return new Response(
          JSON.stringify([
            tradeFixture,
            { ...tradeFixture, pool: "other-pool", signature: "4".repeat(88) },
          ]),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    const snapshot = await getPoolActivitySnapshot(POOL, {
      env: { SOLAMI_DATA_API_KEY: "test-data-key" },
      fetcher,
      limit: 10,
    });
    expect(snapshot.available).toBe(true);
    expect(snapshot.pool?.mint).toBe(MINT);
    expect(snapshot.trades).toHaveLength(1);
    expect(snapshot.trades[0]?.pool).toBe(POOL);
    const urls = fetcher.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes("/token/trades?"))).toBe(true);
    expect(urls.some((url) => url.includes(`address=${MINT}`))).toBe(true);
    expect(urls.some((url) => url.includes("/trades/recent"))).toBe(false);
    expect(urls.some((url) => url.includes("/pool/trades"))).toBe(false);
    expect(urls.join("\n")).not.toContain("test-data-key");
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ "x-api-key": "test-data-key" }),
      }),
    );
    const tradesUrl = urls.find((url) => url.includes("/token/trades?"));
    expect(tradesUrl).toContain(`limit=${tokenTradesFetchLimit(10)}`);
  });

  it("returns an empty trade list when the token feed has no rows for this pool", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/pool?")) {
        return new Response(JSON.stringify(poolFixture), { status: 200 });
      }
      return new Response(JSON.stringify([{ ...tradeFixture, pool: "other-pool" }]), { status: 200 });
    });
    const snapshot = await getPoolActivitySnapshot(POOL, {
      env: { SOLAMI_DATA_API_KEY: "test-data-key" },
      fetcher,
    });
    expect(snapshot.available).toBe(true);
    expect(snapshot.trades).toEqual([]);
  });
});

describe("parseDecimal", () => {
  it("accepts numbers and numeric strings", () => {
    expect(parseDecimal(1.5)).toBe(1.5);
    expect(parseDecimal("2.25")).toBe(2.25);
    expect(parseDecimal("nope")).toBeNull();
  });
});

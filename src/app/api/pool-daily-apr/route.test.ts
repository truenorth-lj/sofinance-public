import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Byte-identical guard for Raydium pools: the response body and headers of GET /api/pool-daily-apr for a Raydium pool
 * are pinned in a file snapshot recorded on the route before it learned about other pool sources (PR9). Any change to
 * the Raydium output fails here. Upstreams are fixed fixtures; the clock is frozen so ageSeconds / fetchedAt are stable.
 */
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => fn }));
vi.mock("next/server", () => ({ after: () => {} }));
const store = vi.hoisted(() => ({ enabled: false, fail: false }));
vi.mock("@/lib/config/rwa-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config/rwa-env")>();
  return { ...actual, getRwaConfig: () => ({ ...actual.getRwaConfig(), enabled: store.enabled }) };
});
vi.mock("@/lib/rwa-store", () => ({
  getRwaStore: () => ({
    request: async () => {
      if (store.fail) throw new Error("store down");
      return [METEORA_TSLA, METEORA_SPCX].map((poolAddress) => ({ pair: { poolAddress, protocol: "meteora-dlmm", mintA: "MintA", mintB: "MintB", blocked: false } }));
    },
  }),
}));

import { DATAPI_POOL_SPCX, DATAPI_POOL_TSLA_TSLAX, DATAPI_VOLUME_SPCX, DATAPI_VOLUME_TSLA_TSLAX, RECORDED_AT } from "@/lib/meteora-daily-apr.fixture";

const RAYDIUM_POOL = "Ray1111111111111111111111111111111111111111";
const METEORA_TSLA = "8k2c9Kiavx5pbWc2dmzhL7vFp11sLgMcKFfSueq8haAh";
const METEORA_SPCX = "5pw5tNUaZJpUCnYjZ1V3gd7XkLbrb4zA9pir4LFph2mj";
const D1 = 1_791_331_200;
const D2 = 1_791_417_600;
const D3 = 1_791_504_000;
const NOW_MS = (D3 + 6 * 3600) * 1000;

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const raydiumFixtures = async (input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("/pools/info/ids")) {
    return json({ success: true, data: [{ feeRate: 0.0005, tvl: 412_345.67, day: { volume: 98_765.4, volumeFee: 49.38, feeApr: 4.37 }, week: { feeApr: 3.91 }, month: { feeApr: 2.88 } }] });
  }
  if (url.includes("/pools/line/liquidity")) {
    return json({ success: true, data: { line: [{ time: D1, liquidity: 380_000.12 }, { time: D2, liquidity: 401_234.5 }, { time: D3, liquidity: 412_345.67 }] } });
  }
  if (url.includes("geckoterminal.com")) {
    return json({ data: { attributes: { ohlcv_list: [[D3, 1, 1, 1, 1, 12_000], [D2, 1, 1, 1, 1, 87_654.32], [D1, 1, 1, 1, 1, 65_432.1]] } } });
  }
  throw new Error(`unexpected url ${url}`);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_MS);
  vi.stubGlobal("fetch", vi.fn(raydiumFixtures));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  store.enabled = false;
  store.fail = false;
  (await import("@/lib/pool-daily-apr")).clearPoolDailyAprCache();
  (await import("@/lib/meteora-daily-apr")).clearMeteoraPoolDailyAprCache();
  (await import("@/lib/dex/meteora-dlmm/pools.server")).clearMeteoraPoolListCache();
});

describe.each([
  ["store off", { enabled: false, fail: false }],
  ["store on (Meteora feed listed)", { enabled: true, fail: false }],
  ["store on but unreadable", { enabled: true, fail: true }],
])("GET /api/pool-daily-apr (Raydium pool, %s)", (_name, state) => {
  beforeEach(() => Object.assign(store, state));
  it("returns byte-identical output to the pre-registry route", async () => {
    const { GET } = await import("./route");
    const response = await GET(new Request(`http://localhost/api/pool-daily-apr?poolId=${RAYDIUM_POOL}`));
    const headers = Object.fromEntries([...response.headers.entries()].sort(([a], [b]) => a.localeCompare(b)));
    const body = await response.text();
    await expect(`${response.status}\n${JSON.stringify(headers, null, 2)}\n${body}\n`).toMatchFileSnapshot("./__snapshots__/raydium-response.txt");
    // Second call is served from the in-memory fast path; pinned too.
    const again = await GET(new Request(`http://localhost/api/pool-daily-apr?poolId=${RAYDIUM_POOL}`));
    await expect(`${again.status}\n${await again.text()}\n`).toMatchFileSnapshot("./__snapshots__/raydium-response-cached.txt");
  });
});

/**
 * Contract: the two listed Meteora RWA pools get a Meteora series through the DEX registry, with non-null daily TVL
 * and APR on every complete day after creation. Upstream bodies are the datapi responses recorded on 2026-11-01.
 */
describe("GET /api/pool-daily-apr (listed Meteora pools, recorded datapi)", () => {
  const recorded: Record<string, { pool: unknown; volume: unknown }> = {
    [METEORA_TSLA]: { pool: DATAPI_POOL_TSLA_TSLAX, volume: DATAPI_VOLUME_TSLA_TSLAX },
    [METEORA_SPCX]: { pool: DATAPI_POOL_SPCX, volume: DATAPI_VOLUME_SPCX },
  };
  beforeEach(() => {
    store.enabled = true;
    vi.setSystemTime(RECORDED_AT * 1000);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.host !== "dlmm.datapi.meteora.ag") throw new Error(`Meteora pool must not reach ${url.host}`);
      const [, , address, kind] = url.pathname.split("/");
      const entry = address ? recorded[address] : undefined;
      if (!entry) return new Response("not found", { status: 404 });
      return json(kind === "volume" ? entry.volume : entry.pool);
    }));
  });

  it.each([
    [METEORA_TSLA, "2026-10-29", 3],
    [METEORA_SPCX, "2026-08-03", 90],
  ])("%s: every point has tvlUsd and aprPct", async (poolId, firstDate, count) => {
    const { GET } = await import("./route");
    const response = await GET(new Request(`http://localhost/api/pool-daily-apr?poolId=${poolId}`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.poolId).toBe(poolId);
    expect(body.assumptions).toMatch(/no daily TVL history/);
    expect(body.feeRate).toBeCloseTo(0.0001, 10);
    expect(body.published.dayFeeApr).toBeGreaterThan(0);
    expect(body.points).toHaveLength(count);
    expect(body.points[0].date).toBe(firstDate);
    expect(body.points.at(-1).date).toBe("2026-10-31");
    for (const point of body.points) {
      expect(point.tvlUsd).toBeGreaterThan(0);
      expect(point.aprPct).not.toBeNull();
      expect(point.aprPct).toBeGreaterThanOrEqual(0);
    }
    expect(body.sources.every((source: string) => source.startsWith("https://dlmm.datapi.meteora.ag/"))).toBe(true);
  });

  it("8k2c 2026-10-30: datapi fees ÷ current TVL × 365", async () => {
    const { GET } = await import("./route");
    const body = await (await GET(new Request(`http://localhost/api/pool-daily-apr?poolId=${METEORA_TSLA}`))).json();
    const day = body.points.find((point: { date: string }) => point.date === "2026-10-30");
    const row = DATAPI_VOLUME_TSLA_TSLAX.data.find((item) => item.timestamp_str.startsWith("2026-10-30"))!;
    expect(day.volumeUsd).toBe(row.volume);
    expect(day.tvlUsd).toBe(DATAPI_POOL_TSLA_TSLAX.tvl);
    expect(day.aprPct).toBeCloseTo((row.fees / DATAPI_POOL_TSLA_TSLAX.tvl) * 365 * 100, 10);
  });

  it("a datapi outage is a plain 400, not a Raydium series", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad gateway", { status: 502 })));
    const { GET } = await import("./route");
    const response = await GET(new Request(`http://localhost/api/pool-daily-apr?poolId=${METEORA_TSLA}`));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/Meteora datapi did not answer for this pool \(pool: Upstream request failed \(502\)/);
  });
});

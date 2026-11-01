import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Byte-identical guard for Raydium pools: the response body and headers of GET /api/pool-daily-apr for a Raydium pool
 * are pinned in a file snapshot recorded on the route before it learned about other pool sources (PR9). Any change to
 * the Raydium output fails here. Upstreams are fixed fixtures; the clock is frozen so ageSeconds / fetchedAt are stable.
 */
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => fn }));
vi.mock("next/server", () => ({ after: () => {} }));
vi.mock("@/lib/rwa-store", () => ({ getRwaStore: () => ({ request: async () => [] }) }));

const RAYDIUM_POOL = "Ray1111111111111111111111111111111111111111";
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
  (await import("@/lib/pool-daily-apr")).clearPoolDailyAprCache();
});

describe("GET /api/pool-daily-apr (Raydium pool)", () => {
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

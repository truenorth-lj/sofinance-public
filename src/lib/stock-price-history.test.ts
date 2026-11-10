import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { loadStockPriceHistory, parseDailyCloses, parseHourlyPrices, resetStockPriceHistoryCache } from "./stock-price-history";

const NVDAX = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
const NVDA = "NVDAVuiB7hwd3m5Wa1JuHNovPaPG6BH1QNztbKFxNjv";
const ms = (iso: string) => Date.parse(iso);
const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;

beforeEach(() => resetStockPriceHistoryCache());

describe("parseDailyCloses", () => {
  it("keys each midnight point to the day it closes and the last point to today", () => {
    const body = { prices: [[ms("2026-10-21T00:00:00Z"), 187.2], [ms("2026-10-22T00:00:00Z"), 190], [ms("2026-10-22T13:00:00Z"), 191], [0, "x"]] };
    expect(parseDailyCloses(body)).toEqual([{ time: day("2026-10-20"), close: 187.2 }, { time: day("2026-10-21"), close: 190 }, { time: day("2026-10-22"), close: 191 }]);
  });
  it("keeps hourly points at their own time", () => {
    expect(parseHourlyPrices({ prices: [[ms("2026-11-09T01:00:00Z"), 176.35]] })).toEqual([{ time: day("2026-11-09") + 3600, close: 176.35 }]);
  });
});

describe("loadStockPriceHistory", () => {
  it("falls back to the next mint, sends the key, and caches the reads", async () => {
    vi.stubEnv("COINGECKO_API_KEY", "demo-key");
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      expect((init?.headers as Record<string, string>)["x-cg-demo-api-key"]).toBe("demo-key");
      if (href.includes(NVDA)) return new Response("not found", { status: 404 });
      if (href.includes("interval=daily")) return Response.json({ prices: [[ms("2026-10-21T00:00:00Z"), 187.2]] });
      return Response.json({ prices: [[ms("2026-11-09T01:00:00Z"), 176.35]] });
    });
    const history = await loadStockPriceHistory([NVDA, NVDAX], { fetcher: fetcher as typeof fetch });
    expect(history).toEqual({ daily: [{ time: day("2026-10-20"), close: 187.2 }], hourly: [{ time: day("2026-11-09") + 3600, close: 176.35 }], source: "CoinGecko daily price" });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith("https://api.coingecko.com/api/v3/coins/solana/contract/"))).toBe(true);
    const calls = fetcher.mock.calls.length;
    await loadStockPriceHistory([NVDA, NVDAX], { fetcher: fetcher as typeof fetch });
    expect(fetcher.mock.calls.length).toBe(calls);
    vi.unstubAllEnvs();
  });

  it("returns null and never throws when every read fails", async () => {
    const fetcher = vi.fn(async () => { throw new Error("offline"); });
    await expect(loadStockPriceHistory([NVDAX], { fetcher: fetcher as typeof fetch })).resolves.toBeNull();
  });
});

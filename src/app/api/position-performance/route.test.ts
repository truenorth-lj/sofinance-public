import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const lookup = vi.hoisted(() => vi.fn());
vi.mock("@/lib/position-performance", () => ({ getPositionPerformance: lookup }));
import { GET } from "./route";
import bs58 from "bs58";
import { PositionHistoryStoreError } from "@/lib/position-history-store-types";
import { captureApiRouteError } from "@/lib/sentry/capture";
import {
  POSITION_PERFORMANCE_LOOKUPS_PER_IP_PER_MINUTE, POSITION_PERFORMANCE_REQUESTS_PER_IP_PER_MINUTE, positionPerformanceRateLimited,
  resetPositionPerformanceRateLimit,
} from "@/lib/position-performance-rate-limit";
vi.mock("@/lib/sentry/capture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sentry/capture")>()), captureApiRouteError: vi.fn(),
}));
afterEach(() => { lookup.mockReset(); vi.restoreAllMocks(); resetPositionPerformanceRateLimit(); });
const mintN = (n: number) => bs58.encode(Buffer.alloc(32, n + 1));
const get = (mint: string, ip = "198.51.100.4", extra = "") => GET(new Request(
  `http://localhost/api/position-performance?positionMint=${mint}${extra}`, { headers: { "x-real-ip": ip } }));
describe("position performance API", () => {
  it("passes the lookup budget and request cancellation while avoiding response caching", async () => {
    lookup.mockResolvedValue({ performance: true });
    const request = new Request(`http://localhost/api/position-performance?positionMint=${"1".repeat(32)}&maxSignatures=50`);
    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(lookup).toHaveBeenCalledWith("1".repeat(32), expect.objectContaining({ maxSignatures: 50, signal: request.signal }));
  });
  it("passes cross-instance refresh and required finalized signatures", async () => {
    lookup.mockResolvedValue({ performance: true });
    const signature = bs58.encode(Buffer.alloc(64, 3));
    const response = await GET(new Request(`http://localhost/api/position-performance?positionMint=${"1".repeat(32)}&refreshHistory=1&historyAfterSignatures=${signature}`));
    expect(response.status).toBe(200);
    expect(lookup).toHaveBeenCalledWith("1".repeat(32), expect.objectContaining({ refreshHistory: true, historyAfterSignatures: [signature] }));
  });
  it("returns retryable availability errors without transport details", async () => {
    lookup.mockRejectedValue(new PositionHistoryStoreError("LEASE_LOST"));
    const response = await GET(new Request(`http://localhost/api/position-performance?positionMint=${"1".repeat(32)}`));
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(await response.json()).toEqual({ code: "LEASE_LOST", error: expect.stringMatching(/temporarily unavailable/) });
  });
  it("rejects an invalid mint or budget before making a lookup", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const query of [`?positionMint=${"1".repeat(32)}&historyAfterSignatures=invalid`, `?positionMint=${"1".repeat(32)}&refreshHistory=bad`, "", "?positionMint=invalid", `?positionMint=${"1".repeat(32)}&maxSignatures=501`]) {
      expect((await GET(new Request(`http://localhost/api/position-performance${query}`))).status).toBe(400);
    }
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("position performance API per-IP limit", () => {
  it("chosen limits: 12 distinct positions and 60 requests per minute per IP", () => {
    expect([POSITION_PERFORMANCE_LOOKUPS_PER_IP_PER_MINUTE, POSITION_PERFORMANCE_REQUESTS_PER_IP_PER_MINUTE]).toEqual([12, 60]);
  });

  it("the 13th distinct position in a minute is 429 with Retry-After, no lookup and no Sentry", async () => {
    lookup.mockResolvedValue({ performance: true });
    for (let i = 0; i < 12; i++) expect((await get(mintN(i))).status).toBe(200);
    const response = await get(mintN(12));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ code: "RATE_LIMITED", error: expect.stringMatching(/more than 12 positions a minute/) });
    expect(lookup).toHaveBeenCalledTimes(12);
    expect(captureApiRouteError).not.toHaveBeenCalled();
  });

  it("normal web use fits: a view's continuation requests (up to 5) for one position count once", async () => {
    lookup.mockResolvedValue({ performance: true });
    for (let i = 0; i < 12; i++) {
      for (let step = 0; step < 5; step++) expect((await get(mintN(i), undefined, step ? "&refreshHistory=1" : "")).status).toBe(200);
    }
    expect(lookup).toHaveBeenCalledTimes(60);
  });

  it("hammering one position stops at 60 requests a minute", async () => {
    lookup.mockResolvedValue({ performance: true });
    for (let i = 0; i < 60; i++) expect((await get(mintN(0))).status).toBe(200);
    expect((await get(mintN(0))).status).toBe(429);
  });

  it("budgets are per IP, and invalid requests are refused before they count", async () => {
    lookup.mockResolvedValue({ performance: true });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (let i = 0; i < 20; i++) expect((await get("invalid")).status).toBe(400);
    for (let i = 0; i < 12; i++) expect((await get(mintN(i))).status).toBe(200);
    expect((await get(mintN(12))).status).toBe(429);
    expect((await get(mintN(12), "198.51.100.5")).status).toBe(200);
  });

  it("refills after a minute", () => {
    const request = new Request("http://localhost/", { headers: { "x-real-ip": "198.51.100.6" } });
    for (let i = 0; i < 12; i++) expect(positionPerformanceRateLimited(request, mintN(i), 1_000)).toBeNull();
    expect(positionPerformanceRateLimited(request, mintN(12), 30_000)).toBe("lookups");
    expect(positionPerformanceRateLimited(request, mintN(0), 30_000)).toBeNull();
    expect(positionPerformanceRateLimited(request, mintN(12), 61_001)).toBeNull();
  });
});

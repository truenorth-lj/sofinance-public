import { beforeEach, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
vi.mock("server-only", () => ({}));
const read = vi.hoisted(() => vi.fn());
const deferred = vi.hoisted(() => vi.fn());
vi.mock("@/lib/dex", () => ({ readPortfolio: read }));
vi.mock("next/server", () => ({ after: deferred }));
import { POST } from "./route";
import { DEX_POSITIONS_REQUESTS_PER_IP_PER_MINUTE, dexRouteRateLimited, resetDexRouteRateLimit } from "@/lib/dex-route-rate-limit";
import { PORTFOLIO_REQUESTS_PER_IP_PER_MINUTE, PORTFOLIO_REQUESTS_PER_LOAD, resetPortfolioRateLimit } from "@/lib/portfolio/rate-limit";
const mint = new PublicKey(Buffer.alloc(32, 7)).toBase58();
const input = { wallet: mint, positions: [{ key: `raydium-clmm:${mint}` }] };
const request = (body: unknown) => new Request("https://example.test/api/portfolio", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => { read.mockReset(); deferred.mockReset(); resetDexRouteRateLimit(); resetPortfolioRateLimit(); });
it("returns a private aggregate with a bounded cancellation signal", async () => {
  read.mockResolvedValue({ wallet: mint, positions: [] });
  const response = await POST(request(input));
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(read).toHaveBeenCalledWith({ ...input, scheduleHistoryRefresh: expect.any(Function) }, expect.any(AbortSignal));
  expect(deferred).toHaveBeenCalledWith(expect.any(Function));
});
it("finishes the response before history work and keeps its background signal independent of the viewer", async () => {
  const viewer = new AbortController();
  const work = vi.fn(async (signal: AbortSignal) => { expect(signal.aborted).toBe(false); });
  read.mockImplementation(async (input) => {
    input.scheduleHistoryRefresh("position", work);
    return { wallet: mint, positions: [] };
  });
  const response = await POST(new Request("https://example.test/api/portfolio", {
    method: "POST", body: JSON.stringify(input), signal: viewer.signal,
  }));
  expect(response.status).toBe(200); expect(work).not.toHaveBeenCalled();
  viewer.abort(); await deferred.mock.calls[0]![0]();
  expect(work).toHaveBeenCalledTimes(1);
});
it("validates keys, decoded public keys, signature sizes and position bounds before I/O", async () => {
  for (const body of [{ ...input, wallet: "bad" }, { ...input, positions: Array(51).fill(input.positions[0]) },
    { ...input, positions: [{ key: `raydium-clmm:${"z".repeat(44)}` }] },
    { ...input, positions: [{ ...input.positions[0], afterSignatures: ["bad"] }] }, { ...input, extra: true }]) {
    expect((await POST(request(body))).status).toBe(400);
  }
  expect(read).not.toHaveBeenCalled();
});
it("bounds the body and suppresses internal errors", async () => {
  expect((await POST(request("x".repeat(60_001)))).status).toBe(413);
  read.mockRejectedValue(new Error("secret endpoint"));
  const response = await POST(request(input));
  expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toContain("secret");
});
it("rate limits repeated requests with its own per-IP budget", async () => {
  read.mockResolvedValue({});
  for (let i = 0; i < PORTFOLIO_REQUESTS_PER_IP_PER_MINUTE; i++) expect((await POST(request(input))).status).toBe(200);
  const response = await POST(request(input));
  expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBe("60");
  expect(read).toHaveBeenCalledTimes(PORTFOLIO_REQUESTS_PER_IP_PER_MINUTE);
  const other = new Request("https://example.test/api/portfolio", { method: "POST", body: JSON.stringify(input), headers: { "x-real-ip": "203.0.113.9" } });
  expect((await POST(other)).status).toBe(200);
});
it("does not spend the /api/dex positions/performance budget", async () => {
  read.mockResolvedValue({});
  for (let i = 0; i < PORTFOLIO_REQUESTS_PER_IP_PER_MINUTE; i++) await POST(request(input));
  for (let i = 0; i < DEX_POSITIONS_REQUESTS_PER_IP_PER_MINUTE; i++) expect(dexRouteRateLimited(request(input), "positions")).toBe(false);
  expect(dexRouteRateLimited(request(input), "performance")).toBe(true);
});
it("lets an LJ-like minute through: several positions, a load and three Refreshes, every follow-up, plus discovery", async () => {
  // One request carries up to 50 positions, so 4 positions are one batch per round. Each load also scans the
  // Meteora and Orca positions routes once (the dex budget); none of that may reach 429.
  read.mockResolvedValue({});
  const loads = 4;
  expect(loads * PORTFOLIO_REQUESTS_PER_LOAD).toBeLessThanOrEqual(PORTFOLIO_REQUESTS_PER_IP_PER_MINUTE);
  const body = { wallet: mint, positions: Array.from({ length: 4 }, (_, n) => ({ key: `raydium-clmm:${new PublicKey(Buffer.alloc(32, n + 1)).toBase58()}` })) };
  for (let load = 0; load < loads; load++) {
    for (const dex of ["meteora-dlmm", "orca-whirlpool"]) {
      expect(dexRouteRateLimited(new Request(`https://example.test/api/dex/${dex}/positions`, { method: "POST" }), "positions")).toBe(false);
    }
    for (let n = 0; n < PORTFOLIO_REQUESTS_PER_LOAD; n++) expect((await POST(request(body))).status).toBe(200);
  }
});

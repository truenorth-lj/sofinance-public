import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const lookup = vi.hoisted(() => vi.fn());
vi.mock("@/lib/position-performance", () => ({ getPositionPerformance: lookup }));
import { GET } from "./route";
import { PositionHistoryStoreError } from "@/lib/position-history-store-types";
afterEach(() => { lookup.mockReset(); vi.restoreAllMocks(); });
describe("position performance API", () => {
  it("passes the lookup budget and request cancellation while avoiding response caching", async () => {
    lookup.mockResolvedValue({ performance: true });
    const request = new Request(`http://localhost/api/position-performance?positionMint=${"1".repeat(32)}&maxSignatures=50`);
    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(lookup).toHaveBeenCalledWith("1".repeat(32), expect.objectContaining({ maxSignatures: 50, signal: request.signal }));
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
    for (const query of ["", "?positionMint=invalid", `?positionMint=${"1".repeat(32)}&maxSignatures=501`]) {
      expect((await GET(new Request(`http://localhost/api/position-performance${query}`))).status).toBe(400);
    }
    expect(lookup).not.toHaveBeenCalled();
  });
});

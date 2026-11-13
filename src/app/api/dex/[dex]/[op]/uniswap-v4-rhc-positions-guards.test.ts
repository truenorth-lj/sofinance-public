import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/protocol-flags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/protocol-flags")>();
  return { ...actual, isRhcUniv4TradingEnabled: vi.fn(actual.isRhcUniv4TradingEnabled) };
});

/** Counts a real `adapter()` / `adapter.server` import. Dynamic import of this module is the adapter load. */
const adapterLoaded = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/lib/dex/uniswap-v4-rhc/adapter.server", () => ({
  createUniswapV4RhcAdapter: () => {
    adapterLoaded.create();
    throw new Error("adapter.server must not be imported for these guards");
  },
}));

import { dexRegistry } from "@/lib/dex";
import { resetDexRouteRateLimit } from "@/lib/dex-route-rate-limit";
import { isRhcUniv4TradingEnabled } from "@/lib/protocol-flags";
import { REQUESTS_PER_IP_PER_MINUTE, resetRhcScanCache, rhcScanRateLimited } from "@/lib/rhc-position-scan";
import { POST } from "./route";

const evmOwner = "0x2222222222222222222222222222222222222222";
const call = (ip = "203.0.113.1") => POST(
  new Request("http://localhost/api/dex/uniswap-v4-rhc/positions", {
    method: "POST",
    body: JSON.stringify({ owner: evmOwner }),
    headers: { "content-type": "application/json", "x-real-ip": ip },
  }),
  { params: Promise.resolve({ dex: "uniswap-v4-rhc", op: "positions" }) },
);

describe("POST /api/dex/uniswap-v4-rhc/positions guards", () => {
  beforeEach(() => {
    resetDexRouteRateLimit();
    resetRhcScanCache({ minSpacingMs: 0 });
    adapterLoaded.create.mockClear();
    vi.mocked(isRhcUniv4TradingEnabled).mockReset();
    vi.mocked(isRhcUniv4TradingEnabled).mockImplementation(() => true);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("404s when Robinhood Chain trading is off, without loading the adapter or scanning", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(isRhcUniv4TradingEnabled).mockReturnValue(false);
    expect(dexRegistry.isDisabled("uniswap-v4-rhc", "positions")).toBe(true);
    const response = await call();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(adapterLoaded.create).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rate-limits per IP with the dedicated scan bucket (429 + Retry-After 60), without loading the adapter or scanning", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ip = "203.0.113.1";
    // Fill the same in-memory bucket GET /api/rhc-univ4-positions uses (rhcScanRateLimited).
    for (let i = 0; i < REQUESTS_PER_IP_PER_MINUTE; i++) expect(rhcScanRateLimited(ip)).toBe(false);
    const limited = await call(ip);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(await limited.json()).toEqual({ error: "Too many requests. Please wait a minute." });
    expect(adapterLoaded.create).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

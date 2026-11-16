import { afterEach, expect, it, vi } from "vitest";
import { evmPositionReadPolicyFor, readEvmPositions, readEvmPositionValues } from "./index";
import { isRhcUniv4TradingEnabled } from "@/lib/protocol-flags";
import { REQUESTS_PER_IP_PER_MINUTE, resetRhcScanRateLimit } from "@/lib/rhc-scan-rate-limit";
import { GET as positionsGet } from "@/app/api/rhc-univ4-positions/route";
import { GET as valuesGet } from "@/app/api/rhc-univ4-position-values/route";
import { POST as genericPost } from "@/app/api/dex/[dex]/[op]/route";
import { resetDexRouteRateLimit } from "@/lib/dex-route-rate-limit";

vi.mock("server-only", () => ({}));
const backend = vi.hoisted(() => ({ loaded: [] as string[], scans: vi.fn(), values: vi.fn() }));
vi.mock("@/lib/dex/uniswap-v4-rhc/position-scan.server", () => {
  backend.loaded.push("scan");
  return { scanRhcPositions: backend.scans, RhcScanBusyError: class extends Error {}, RHC_SCAN_FAILED_MESSAGE: "scan failed" };
});
vi.mock("@/lib/dex/uniswap-v4-rhc/position-values.server", () => {
  backend.loaded.push("values"); return { rhcPositionValues: backend.values };
});
vi.mock("@/lib/protocol-flags", async original => {
  const actual = await original<typeof import("@/lib/protocol-flags")>();
  return { ...actual, isRhcUniv4TradingEnabled: vi.fn(actual.isRhcUniv4TradingEnabled) };
});
afterEach(() => { vi.unstubAllEnvs(); vi.mocked(isRhcUniv4TradingEnabled).mockReset(); resetRhcScanRateLimit(); resetDexRouteRateLimit(); });
const WALLET = "0x2222222222222222222222222222222222222222";
const request = (path: string, ip: string) => new Request(`https://example.test/api/${path}`, { headers: { "x-forwarded-for": ` ${ip} , 198.51.100.1` } });
const generic = (ip: string) => genericPost(new Request("https://example.test/api/dex/uniswap-v4-rhc/positions", {
  method: "POST", headers: { "x-forwarded-for": ip, "content-type": "application/json" }, body: JSON.stringify({ owner: WALLET }),
}), { params: Promise.resolve({ dex: "uniswap-v4-rhc", op: "positions" }) });

it("keeps metadata/invalid/disabled requests lazy and shares one IP budget across all three position endpoints", async () => {
  resetRhcScanRateLimit(); resetDexRouteRateLimit();
  backend.scans.mockResolvedValue({ state: "scan", wallet: WALLET, positions: [], scannedToBlock: "1", checkedAt: 0, rpcCalls: 0 });
  backend.values.mockResolvedValue({ state: "values", values: [], checkedAt: 0 });
  expect(evmPositionReadPolicyFor("uniswap-v4-rhc").parseIds("1,01")).toEqual([1n]);
  expect(backend.loaded).toEqual([]);
  vi.mocked(isRhcUniv4TradingEnabled).mockReturnValue(true);
  expect((await positionsGet(request("rhc-univ4-positions?wallet=bad", "203.0.113.33"))).status).toBe(400);
  expect((await valuesGet(request("rhc-univ4-position-values?ids=-1", "203.0.113.33"))).status).toBe(400);
  for (const target of ["production", "preview", "development"]) {
    vi.stubEnv("VERCEL_ENV", target); vi.mocked(isRhcUniv4TradingEnabled).mockReturnValue(false);
    expect((await positionsGet(request(`rhc-univ4-positions?wallet=${WALLET}`, "203.0.113.33"))).status).toBe(404);
    expect((await valuesGet(request("rhc-univ4-position-values?ids=1", "203.0.113.33"))).status).toBe(404);
    await expect(readEvmPositions("uniswap-v4-rhc", WALLET)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(readEvmPositionValues("uniswap-v4-rhc", [1n])).rejects.toMatchObject({ code: "UNSUPPORTED" });
  }
  expect(backend.loaded).toEqual([]);
  vi.mocked(isRhcUniv4TradingEnabled).mockReturnValue(true);
  const scan = (ip: string) => positionsGet(request(`rhc-univ4-positions?wallet=${WALLET}`, ip));
  const values = (ip: string) => valuesGet(request("rhc-univ4-position-values?ids=1", ip));
  const routes = [scan, values, generic], ip = "203.0.113.33";
  for (let i = 0; i < REQUESTS_PER_IP_PER_MINUTE; i++) expect((await routes[i % 3]!(ip)).status).toBe(200);
  const calls = backend.scans.mock.calls.length + backend.values.mock.calls.length;
  expect(backend.loaded).toEqual(["scan", "values"]);
  for (const route of routes) {
    const response = await route(ip);
    expect(response.status).toBe(429); expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  expect(backend.scans.mock.calls.length + backend.values.mock.calls.length).toBe(calls);
  expect((await scan("203.0.113.34")).status).toBe(200);
});

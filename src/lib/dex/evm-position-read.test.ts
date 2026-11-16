import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MAX_POSITION_VALUES } from "@sofinance/engine/protocols/uniswap-v4/position-value";
import type { EvmPositionScanResult } from "@/lib/evm-position-types";
import { createDexRegistry } from "./registry";
import { uniswapV4RhcModule } from "./uniswap-v4-rhc/module";
import { evmPositionReadPolicyFor, PositionReadBusyError, readEvmPositions, readEvmPositionValues } from "./index";
import * as scans from "./uniswap-v4-rhc/position-scan.server";
import * as values from "./uniswap-v4-rhc/position-values.server";
import { GET as positionsGet } from "@/app/api/rhc-univ4-positions/route";
import { GET as valuesGet } from "@/app/api/rhc-univ4-position-values/route";
import { resetRhcScanRateLimit } from "@/lib/rhc-scan-rate-limit";

vi.mock("server-only", () => ({}));
const logged = vi.fn<(...args: unknown[]) => void>();
const WALLET = "0x2222222222222222222222222222222222222222";
const scanResult: EvmPositionScanResult = { state: "scan" as const, wallet: WALLET, positions: [], scannedToBlock: "9007199254740993", checkedAt: 123, rpcCalls: 0 };
const valueResult = { state: "values" as const, values: [], checkedAt: 456 };
const request = (path: string) => new Request(`https://example.test/api/${path}`, { headers: { "x-real-ip": "203.0.113.22" } });
beforeEach(() => { resetRhcScanRateLimit(); vi.stubEnv("VERCEL_ENV", "production"); logged.mockClear(); vi.spyOn(console, "error").mockImplementation(logged); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("captures freshness and exact bigint NFT ids before lazy imports and preserves native responses", async () => {
  const scan = vi.spyOn(scans, "scanRhcPositions").mockResolvedValue(scanResult);
  const read = vi.spyOn(values, "rhcPositionValues").mockResolvedValue(valueResult);
  const options = { fresh: true }, ids = [9007199254740993n, 1n];
  const pendingScan = readEvmPositions("uniswap-v4-rhc", WALLET, options);
  const pendingValues = readEvmPositionValues("uniswap-v4-rhc", ids);
  options.fresh = false; ids[0] = 2n; ids.push(3n);
  expect(await pendingScan).toBe(scanResult); expect(await pendingValues).toBe(valueResult);
  expect(scan).toHaveBeenCalledExactlyOnceWith(WALLET, { fresh: true });
  expect(read).toHaveBeenCalledExactlyOnceWith([9007199254740993n, 1n]);
});

it("retains busy error identity and distinct HTTP retry headers while suppressing upstream details", async () => {
  const busy = new scans.RhcScanBusyError(1501);
  expect(busy).toBeInstanceOf(PositionReadBusyError); expect(busy.name).toBe("RhcScanBusyError");
  vi.spyOn(scans, "scanRhcPositions").mockRejectedValue(busy);
  vi.spyOn(values, "rhcPositionValues").mockRejectedValue(busy);
  await expect(readEvmPositions("uniswap-v4-rhc", WALLET)).rejects.toBe(busy);
  const scanResponse = await positionsGet(request(`rhc-univ4-positions?wallet=${WALLET}`));
  expect(scanResponse.status).toBe(503); expect(scanResponse.headers.get("Retry-After")).toBe("2");
  expect(scanResponse.headers.get("Cache-Control")).toBe("no-store");
  expect(await scanResponse.json()).toEqual({ error: scans.RHC_SCAN_FAILED_MESSAGE, code: "rpc_busy" });
  const valueResponse = await valuesGet(request("rhc-univ4-position-values?ids=1"));
  expect(valueResponse.status).toBe(503); expect(valueResponse.headers.get("Retry-After")).toBeNull();
  expect(valueResponse.headers.get("Cache-Control")).toBe("no-store");
  expect(await valueResponse.json()).toEqual({ error: "Couldn't read position amounts right now.", code: "rpc_busy" });
  expect(logged).not.toHaveBeenCalled();
});

it("keeps decimal-id validation and the engine limit, including counting input entries before deduplication", () => {
  const policy = evmPositionReadPolicyFor("uniswap-v4-rhc");
  expect(policy.parseIds(" 01, 1,, 9007199254740993, ")).toEqual([1n, 9007199254740993n]);
  expect(policy.parseIds(Array(MAX_POSITION_VALUES).fill("1").join(","))).toEqual([1n]);
  expect(policy.parseIds(Array(MAX_POSITION_VALUES + 1).fill("1").join(","))).toBeNull();
  for (const raw of [null, "", "1,-1", "1e3", "0x1", "1.0", "1".repeat(31)]) expect(policy.parseIds(raw)).toBeNull();
});

it("denies disabled or absent native bindings before reads, without changing generic capabilities", async () => {
  const scan = vi.spyOn(scans, "scanRhcPositions"), read = vi.spyOn(values, "rhcPositionValues");
  const registry = createDexRegistry([{ ...uniswapV4RhcModule,
    evmPositionReads: { ...uniswapV4RhcModule.evmPositionReads!, enabled: () => false } }]);
  for (const id of ["uniswap-v4-rhc", "raydium-clmm", "unknown"]) {
    await expect(registry.readEvmPositions(id, WALLET)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(registry.readEvmPositionValues(id, [1n])).rejects.toMatchObject({ code: "UNSUPPORTED" });
  }
  expect(() => registry.evmPositionReadPolicyFor("unknown")).toThrow(/not available/i);
  expect(registry.isDisabled("uniswap-v4-rhc", "open")).toBe(true);
  expect(registry.descriptorFor("uniswap-v4-rhc")?.capabilities.performance.supported).toBe(false);
  expect(scan).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/protocol-flags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/protocol-flags")>();
  return { ...actual, isRhcUniv4TradingEnabled: vi.fn(() => true) };
});
const storeRequest = vi.hoisted(() => vi.fn());
const storeEnabled = vi.hoisted(() => ({ value: false }));
const fakeScanClient = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/rhc-position-scan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rhc-position-scan")>();
  return { ...actual, createScanClient: (...args: Parameters<typeof actual.createScanClient>) => (fakeScanClient.value ?? actual.createScanClient(...args)) as never };
});
vi.mock("@/lib/rwa-store", () => ({ getRwaStore: () => ({ request: storeRequest }) }));
vi.mock("@/lib/config/rwa-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config/rwa-env")>();
  return { ...actual, getRwaConfig: () => ({ ...actual.getRwaConfig(), enabled: storeEnabled.value }) };
});
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { isRhcUniv4TradingEnabled } from "@/lib/protocol-flags";
import { resetRhcScanCache, RHC_SCAN_USER_AGENT } from "@/lib/rhc-position-scan";
import { parsePositionIds, resetRhcPositionValuesCache, rhcPositionValues } from "@/lib/rhc-position-values";
import { GET } from "./route";

const POOL = UNIV4_RHC_ALLOWLISTED_POOLS[0]!;
const get = (qs: string) => GET(new Request(`https://example.test/api/rhc-univ4-position-values${qs}`, { headers: { "x-real-ip": "203.0.113.9" } }));

describe("GET /api/rhc-univ4-position-values", () => {
  beforeEach(() => { resetRhcScanCache({ minSpacingMs: 0 }); resetRhcPositionValuesCache(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); resetRhcScanCache(); resetRhcPositionValuesCache(); });

  it("404 when Robinhood Chain is off for this deployment", async () => {
    vi.mocked(isRhcUniv4TradingEnabled).mockReturnValueOnce(false);
    expect((await get("?ids=1")).status).toBe(404);
  });

  it("validates ids: decimal NFT numbers, 1 to 10, no RPC call on a bad request", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    for (const qs of ["", "?ids=", "?ids=abc", "?ids=1,-2", `?ids=${Array.from({ length: 11 }, (_, i) => i + 1).join(",")}`]) {
      expect((await get(qs)).status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(parsePositionIds("9, 8,9")).toEqual([9n, 8n]);
  });

  it("reads only the official public RPC (with the scan User-Agent), never RHC_RPC_URL; a failed read is a plain 503", async () => {
    vi.stubEnv("RHC_RPC_URL", "https://paid-rpc.invalid/v2/not-a-real-key");
    const fetchMock = vi.fn(async () => new Response("upstream down", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await get("?ids=4014633");
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body).toEqual({ error: "Couldn't read position amounts right now.", code: "rpc_unavailable" });
    expect(fetchMock).toHaveBeenCalled();
    for (const [url, init] of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(new URL(String(url)).origin).toBe("https://rpc.mainnet.chain.robinhood.com");
      expect(new Headers(init?.headers).get("User-Agent")).toBe(RHC_SCAN_USER_AGENT);
    }
  });
});

describe("rhcPositionValues: USD from the cron's saved pool data only", () => {
  const NOW = Date.parse("2026-11-01T04:00:00Z");
  const Q96 = 1n << 96n;
  const key = { currency0: POOL.currency0.address, currency1: POOL.currency1.address, fee: POOL.fee, tickSpacing: POOL.tickSpacing, hooks: POOL.hooks };
  const client = () => ({ multicall: vi.fn()
    .mockResolvedValueOnce([{ status: "success", result: 10n ** 18n }, { status: "success", result: [key, (77n << 32n) | (BigInt(-123 & 0xffffff) << 8n)] }])
    .mockResolvedValueOnce([{ status: "success", result: [Q96, 0, 0, 0] }, { status: "success", result: [0n, 0n] }, { status: "success", result: [10n ** 18n, 0n, 0n] }]) });
  const saved = (observedAt: string | null, tokenPricesUsd: unknown) => ({
    pools: [{ poolId: POOL.poolId, protocol: "uniswap-v4-rhc", tokenPricesUsd }], observedAt, stale: false,
  }) as never;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetRhcPositionValuesCache(); storeRequest.mockReset(); storeEnabled.value = true;
    fetchMock = vi.fn(async () => { throw new Error("no network on this path"); }); vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); storeEnabled.value = false; });

  it("uses the saved DB price (rwa_pool_latest summary), one store read, no indexer call; caches per id set", async () => {
    storeRequest.mockResolvedValue(saved("2026-11-01T00:00:00.000Z", { token0: 140.32, token1: 140.33 }));
    const c = client();
    const first = await rhcPositionValues([9n], { client: c as never, now: () => NOW });
    expect(first.values).toEqual([expect.objectContaining({ tokenId: "9", fees0: "0", fees1: "0", priceUsd0: 140.32, priceUsd1: 140.33 })]);
    await rhcPositionValues([9n], { client: c as never, now: () => NOW });
    expect(c.multicall).toHaveBeenCalledTimes(2);
    expect(storeRequest).toHaveBeenCalledTimes(1);
    expect(storeRequest).toHaveBeenCalledWith({ op: "rhcPools" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a saved price older than 48h shows a dash (null); amounts still shown", async () => {
    storeRequest.mockResolvedValue(saved(new Date(NOW - 48 * 3_600_000 - 1).toISOString(), { token0: 140.32, token1: 140.33 }));
    const { values } = await rhcPositionValues([9n], { client: client() as never, now: () => NOW });
    expect(values[0]).toMatchObject({ amount0: expect.any(String), priceUsd0: null, priceUsd1: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no saved price (old summary without the field, a null price, a failed store read, or no store) shows a dash", async () => {
    for (const setup of [
      () => storeRequest.mockResolvedValue(saved("2026-11-01T00:00:00.000Z", undefined)),
      () => storeRequest.mockResolvedValue(saved("2026-11-01T00:00:00.000Z", null)),
      () => storeRequest.mockResolvedValue(saved(null, { token0: 1, token1: 1 })),
      () => storeRequest.mockRejectedValue(new Error("SNAPSHOT_UNAVAILABLE")),
      () => { storeEnabled.value = false; },
    ]) {
      resetRhcPositionValuesCache(); storeRequest.mockReset(); storeEnabled.value = true; setup();
      const { values } = await rhcPositionValues([9n], { client: client() as never, now: () => NOW });
      expect(values[0]).toMatchObject({ priceUsd0: null, priceUsd1: null });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the user path (GET route) never calls GeckoTerminal or DexScreener; USD comes from the store", async () => {
    storeRequest.mockResolvedValue(saved(new Date(Date.now() - 3_600_000).toISOString(), { token0: 140.32, token1: 140.33 }));
    fakeScanClient.value = client();
    try {
      const response = await get("?ids=9");
      expect(response.status).toBe(200);
      expect((await response.json()).values[0]).toMatchObject({ tokenId: "9", priceUsd0: 140.32, priceUsd1: 140.33 });
    } finally { fakeScanClient.value = null; }
    expect(storeRequest).toHaveBeenCalledWith({ op: "rhcPools" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

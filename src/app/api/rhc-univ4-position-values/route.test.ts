import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/protocol-flags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/protocol-flags")>();
  return { ...actual, isRhcUniv4TradingEnabled: vi.fn(() => true) };
});
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { isRhcUniv4TradingEnabled } from "@/lib/protocol-flags";
import { resetRhcScanCache, RHC_SCAN_USER_AGENT } from "@/lib/rhc-position-scan";
import { parsePositionIds, resetRhcPositionValuesCache, rhcPositionValues } from "@/lib/rhc-position-values";
import { resetRhcUniv4PoolsCache } from "@/lib/rhc-univ4-pools";
import { GET } from "./route";

const POOL = UNIV4_RHC_ALLOWLISTED_POOLS[0]!;
const get = (qs: string) => GET(new Request(`https://example.test/api/rhc-univ4-position-values${qs}`, { headers: { "x-real-ip": "203.0.113.9" } }));

describe("GET /api/rhc-univ4-position-values", () => {
  beforeEach(() => { resetRhcScanCache({ minSpacingMs: 0 }); resetRhcPositionValuesCache(); resetRhcUniv4PoolsCache(); });
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

describe("rhcPositionValues", () => {
  beforeEach(() => { resetRhcPositionValuesCache(); resetRhcUniv4PoolsCache(); });

  it("adds token USD prices from the public indexer (DexScreener) and caches per id set", async () => {
    const Q96 = 1n << 96n;
    const key = { currency0: POOL.currency0.address, currency1: POOL.currency1.address, fee: POOL.fee, tickSpacing: POOL.tickSpacing, hooks: POOL.hooks };
    const multicall = vi.fn()
      .mockResolvedValueOnce([{ status: "success", result: 10n ** 18n }, { status: "success", result: [key, (77n << 32n) | (BigInt(-123 & 0xffffff) << 8n)] }])
      .mockResolvedValueOnce([{ status: "success", result: [Q96, 0, 0, 0] }, { status: "success", result: [0n, 0n] }, { status: "success", result: [10n ** 18n, 0n, 0n] }]);
    const fetcher = vi.fn(async () => Response.json({ pair: { chainId: "robinhood", pairAddress: POOL.poolId,
      baseToken: { address: POOL.currency0.address }, quoteToken: { address: POOL.currency1.address },
      volume: { h24: 10 }, liquidity: { usd: 100, base: 1, quote: 1 }, priceUsd: "250", priceNative: "1" } }));
    const first = await rhcPositionValues([9n], { client: { multicall } as never, fetcher: fetcher as never });
    expect(first.values).toEqual([expect.objectContaining({ tokenId: "9", fees0: "0", fees1: "0", priceUsd0: 250, priceUsd1: 250 })]);
    await rhcPositionValues([9n], { client: { multicall } as never, fetcher: fetcher as never });
    expect(multicall).toHaveBeenCalledTimes(2);
  });
});

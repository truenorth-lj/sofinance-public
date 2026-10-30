import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/protocol-flags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/protocol-flags")>();
  return { ...actual, isRhcUniv4TradingEnabled: vi.fn(actual.isRhcUniv4TradingEnabled) };
});
import { isRhcUniv4TradingEnabled } from "@/lib/protocol-flags";
import { REQUESTS_PER_IP_PER_MINUTE, resetRhcScanCache, RHC_SCAN_FAILED_MESSAGE, RHC_SCAN_USER_AGENT } from "@/lib/rhc-position-scan";
import { GET } from "./route";

const USER = "0xb95b77e9429643cbafde865fa2a9f687e8d21b04";
const get = (qs: string, ip = "203.0.113.7") => GET(new Request(`https://example.test/api/rhc-univ4-positions${qs}`, { headers: { "x-real-ip": ip } }));

/** Official-RPC stand-in: no transfers to the wallet, so a scan is blockNumber + 11 getLogs (no multicall). */
function stubRpc(fail = false) {
  const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    if (fail) return new Response("upstream down", { status: 502 });
    const body = JSON.parse(String(init?.body)) as { id: number; method: string };
    const result = body.method === "eth_blockNumber" ? "0x610c0d1" : body.method === "eth_chainId" ? "0x1237" : [];
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("GET /api/rhc-univ4-positions", () => {
  beforeEach(() => resetRhcScanCache({ minSpacingMs: 0 }));
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); resetRhcScanCache(); });

  it("scans on the official public RPC with a User-Agent, never the paid RHC_RPC_URL, and caches per wallet", async () => {
    vi.stubEnv("RHC_RPC_URL", "https://paid-rpc.invalid/v2/not-a-real-key");
    const fetchMock = stubRpc();
    const response = await get(`?wallet=${USER}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ state: "scan", wallet: "0xB95b77e9429643cbaFdE865Fa2a9F687e8d21b04", positions: [], rpcCalls: 12 });
    expect(fetchMock).toHaveBeenCalledTimes(12);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(new URL(String(url)).origin).toBe("https://rpc.mainnet.chain.robinhood.com");
      expect(new Headers(init?.headers).get("User-Agent")).toBe(RHC_SCAN_USER_AGENT);
    }
    expect(JSON.stringify(body)).not.toContain("paid-rpc");
    const again = await (await get(`?wallet=${USER}`)).json();
    expect(again.rpcCalls).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(12);
  });

  it("validates the wallet address", async () => {
    const fetchMock = stubRpc();
    for (const qs of ["", "?wallet=0x123", "?wallet=not-an-address", `?wallet=${USER}00`, `?wallet=${"0x" + "g".repeat(40)}`]) {
      const response = await get(qs);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid wallet address" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rate-limits per IP (429 with Retry-After)", async () => {
    stubRpc();
    for (let i = 0; i < REQUESTS_PER_IP_PER_MINUTE; i++) expect((await get(`?wallet=${USER}`)).status).toBe(200);
    const limited = await get(`?wallet=${USER}`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect((await get(`?wallet=${USER}`, "198.51.100.1")).status).toBe(200);
  });

  it("fails gracefully: 503 with a plain message and no upstream details", async () => {
    stubRpc(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await get(`?wallet=${USER}`);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ error: RHC_SCAN_FAILED_MESSAGE, code: "rpc_unavailable" });
  });

  it("404s when Robinhood Chain trading is off", async () => {
    const fetchMock = stubRpc();
    vi.mocked(isRhcUniv4TradingEnabled).mockReturnValueOnce(false);
    expect((await get(`?wallet=${USER}`)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

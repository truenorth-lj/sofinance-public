import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { getPositionHistoryStore } from "./position-history-store";
const context = Object.fromEntries(["positionMint", "positionAccount", "poolId", "mintA", "mintB", "vaultA", "vaultB"]
  .map(key => [key, "1".repeat(32)])) as { positionMint: string; positionAccount: string; poolId: string;
    mintA: string; mintB: string; vaultA: string; vaultB: string };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function configure() {
  vi.stubEnv("SOFINANCE_RWA_STORE_MODE", "gateway");
  vi.stubEnv("SOFINANCE_RWA_GATEWAY_URL", "https://rwa.example.com");
  vi.stubEnv("CRON_SECRET", "test-only-".repeat(8));
  vi.stubEnv("VERCEL", "1");
}
describe("position history HTTPS transport", () => {
  it("uses the authenticated private gateway with a validated request", async () => {
    configure();
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: expect.stringMatching(/^Bearer /) });
      expect(JSON.parse(String(init?.body))).toEqual({ op: "claim", context, parserVersion: 1 });
      return Response.json({ stored: true });
    });
    vi.stubGlobal("fetch", fetcher);
    expect(await getPositionHistoryStore().request({ op: "claim", context, parserVersion: 1 })).toEqual({ stored: true });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://rwa.example.com/v1/position-history");
    expect(getPositionHistoryStore()).toBe(getPositionHistoryStore());
    const first = getPositionHistoryStore();
    vi.stubEnv("CRON_SECRET", "rotated-test-".repeat(8));
    expect(getPositionHistoryStore()).not.toBe(first);
  });
  it("rejects insecure production transport and direct production PostgreSQL", () => {
    configure();
    vi.stubEnv("SOFINANCE_RWA_GATEWAY_URL", "http://localhost:3000");
    expect(() => getPositionHistoryStore()).toThrow("INVALID_GATEWAY_URL");
    vi.stubEnv("SOFINANCE_RWA_GATEWAY_URL", "");
    expect(() => getPositionHistoryStore()).toThrow("POSITION_STORE_UNAVAILABLE");
  });
  it("turns private transport failures into stable public error codes", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("private connection details"); }));
    await expect(getPositionHistoryStore().request({ op: "claim", context, parserVersion: 1 }))
      .rejects.toMatchObject({ code: "POSITION_STORE_UNAVAILABLE" });
  });
});

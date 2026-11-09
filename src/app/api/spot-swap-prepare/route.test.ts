import { Keypair } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpotSwapError } from "@sofinance/engine/spot-swap";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ context: vi.fn(), prepare: vi.fn(), quote: vi.fn() }));
vi.mock("@/lib/stock-market/source", () => ({ loadSpotSwapStockContext: mocks.context }));
vi.mock("@/server/transactions/spot-swap", () => ({
  prepareSpotSwapForStock: mocks.prepare, quoteSpotSwapForStock: mocks.quote, SpotSwapNoRouteError: class extends Error {},
}));

const { POST: prepare } = await import("./route");
const { POST: quote } = await import("../spot-swap-quote/route");

const wallet = Keypair.generate().publicKey.toBase58();
const mint = Keypair.generate().publicKey.toBase58();
const context = { underlying: "TSLA", candidates: [{ mint }] };
const request = (path: string, body: string) => new Request(`http://localhost${path}`, { method: "POST", body });
const valid = { wallet, underlying: "TSLA", mint, amount: "2", minOut: "4477500" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.context.mockResolvedValue(context);
  mocks.prepare.mockResolvedValue({ ok: true });
  mocks.quote.mockResolvedValue({ ok: true });
});

describe("spot-swap routes reject bodies that are not JSON objects", () => {
  it.each(["null", "[]", "\"TSLA\"", "7", "not json"])("%s -> 400 with plain words, nothing loaded", async (body) => {
    for (const [route, path] of [[prepare, "/api/spot-swap-prepare"], [quote, "/api/spot-swap-quote"]] as const) {
      const response = await route(request(path, body));
      expect(response.status).toBe(400);
      expect((await response.json() as { error: string }).error).toMatch(/^(This purchase request is not valid|Enter a USDC amount)/);
    }
    expect(mocks.context).not.toHaveBeenCalled();
  });
});

describe("POST /api/spot-swap-prepare binds the confirmed minimum", () => {
  it("passes the minimum the user confirmed to the build, as raw units", async () => {
    const response = await prepare(request("/api/spot-swap-prepare", JSON.stringify(valid)));
    expect(response.status).toBe(200);
    expect(mocks.prepare).toHaveBeenCalledWith(context, wallet, mint, "2", 4_477_500n);
  });

  it.each([undefined, "", "0", "-1", "1.5", "abc", 4477500, "99999999999999999999999"])("refuses minOut %s without building", async (minOut) => {
    const response = await prepare(request("/api/spot-swap-prepare", JSON.stringify({ ...valid, minOut })));
    expect(response.status).toBe(400);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("returns the new terms with plain words when the route moved below the confirmed minimum", async () => {
    const terms = { quotedOut: "2250000", minOut: "2238750", priceImpactPct: "0.0009" };
    mocks.prepare.mockRejectedValue(new SpotSwapError("spot_swap_quote_changed",
      "The price moved since your quote, so nothing was prepared. Check the new amount and press Buy again.", terms));
    const response = await prepare(request("/api/spot-swap-prepare", JSON.stringify(valid)));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "The price moved since your quote, so nothing was prepared. Check the new amount and press Buy again.",
      code: "spot_swap_quote_changed", quote: terms,
    });
  });
});

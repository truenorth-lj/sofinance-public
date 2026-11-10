import { afterEach, describe, expect, it, vi } from "vitest";
import { NATIVE_SOL_MINT, USDC_MINT } from "@sofinance/engine/ids";
import type { TokenPriceQuote } from "@sofinance/engine/token-prices";

vi.mock("@sofinance/engine/token-prices", () => ({ fetchTokenPricesUsd: vi.fn() }));
import { fetchTokenPricesUsd } from "@sofinance/engine/token-prices";
import { GET } from "./route";

afterEach(() => vi.resetAllMocks());

const quote = (price: number, source: TokenPriceQuote["source"]): TokenPriceQuote => ({ price, source });

describe("SOL/USDC reference price", () => {
  it("uses both USD prices rather than assuming USDC equals one dollar", async () => {
    vi.mocked(fetchTokenPricesUsd).mockResolvedValue(new Map([
      [NATIVE_SOL_MINT, quote(150, "jupiter")],
      [USDC_MINT, quote(0.99, "jupiter")],
    ]));
    const response = await GET();
    const body = await response.json() as { rate: number; source: string };
    expect(body.rate).toBe(150 / 0.99);
    expect(body.source).toBe("jupiter");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("labels a DexScreener fallback instead of Jupiter", async () => {
    vi.mocked(fetchTokenPricesUsd).mockResolvedValue(new Map([
      [NATIVE_SOL_MINT, quote(150, "dexscreener")],
      [USDC_MINT, quote(1, "dexscreener")],
    ]));
    expect((await (await GET()).json() as { source: string }).source).toBe("dexscreener");
  });
  it("returns unavailable for missing or invalid prices", async () => {
    for (const usdc of [undefined, 0, -1, NaN]) {
      vi.mocked(fetchTokenPricesUsd).mockResolvedValue(new Map([
        [NATIVE_SOL_MINT, quote(150, "jupiter")],
        ...(usdc === undefined ? [] : [[USDC_MINT, quote(usdc, "jupiter")] as [string, TokenPriceQuote]]),
      ]));
      expect((await (await GET()).json()).rate).toBeNull();
    }
  });
});

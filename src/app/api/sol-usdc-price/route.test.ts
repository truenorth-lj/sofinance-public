import { afterEach, describe, expect, it, vi } from "vitest";
import { NATIVE_SOL_MINT, USDC_MINT } from "@/lib/ids";

vi.mock("@/lib/token-prices", () => ({ fetchJupiterPricesUsd: vi.fn() }));
import { fetchJupiterPricesUsd } from "@/lib/token-prices";
import { GET } from "./route";

afterEach(() => vi.resetAllMocks());

describe("SOL/USDC reference price", () => {
  it("uses both USD prices rather than assuming USDC equals one dollar", async () => {
    vi.mocked(fetchJupiterPricesUsd).mockResolvedValue(new Map([[NATIVE_SOL_MINT, 150], [USDC_MINT, 0.99]]));
    const response = await GET();
    expect((await response.json()).rate).toBe(150 / 0.99);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("returns unavailable for missing or invalid prices", async () => {
    for (const usdc of [undefined, 0, -1, NaN]) {
      vi.mocked(fetchJupiterPricesUsd).mockResolvedValue(new Map([[NATIVE_SOL_MINT, 150], ...(usdc === undefined ? [] : [[USDC_MINT, usdc] as [string, number]])]));
      expect((await (await GET()).json()).rate).toBeNull();
    }
  });
});

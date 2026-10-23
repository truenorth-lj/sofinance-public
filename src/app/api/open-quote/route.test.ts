import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/open-quote", () => ({ getOpenPositionQuoteBundle: vi.fn() }));
vi.mock("@/lib/open-pool-snapshot", () => ({ cachedOpenPoolState: vi.fn() }));

import { JUPITER_MAX_ACCOUNTS } from "@sofinance/engine/jupiter-route-retry";
import { getOpenPositionQuoteBundle } from "@sofinance/engine/open-quote";
import { cachedOpenPoolState } from "@/lib/open-pool-snapshot";
import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(cachedOpenPoolState).mockResolvedValue({ fetchedAt: Date.now() } as never);
  vi.mocked(getOpenPositionQuoteBundle).mockResolvedValue({ quote: { ok: true } } as never);
});

describe("open-position quote API", () => {
  it("quotes in parallel at the same wide budget prepare uses, against a cached snapshot", async () => {
    const wallet = "11111111111111111111111111111111";
    const poolId = "So11111111111111111111111111111111111111112";
    const inputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const response = await POST(new Request("http://localhost/api/open-quote", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, poolId, inputMint, inputKind: "token", amount: "0.12", rangePreset: "standard" }),
    }));
    expect(response.status).toBe(200);
    expect(cachedOpenPoolState).toHaveBeenCalledWith(wallet, { poolId, inputMint, inputKind: "token" });
    expect(getOpenPositionQuoteBundle).toHaveBeenCalledWith(
      wallet, { poolId, inputMint, inputKind: "token" }, "0.12", { preset: "standard" },
      expect.any(Number), expect.any(Number),
      { maxAccounts: JUPITER_MAX_ACCOUNTS.wide },
      await vi.mocked(cachedOpenPoolState).mock.results[0]!.value,
      "parallel", { build: false },
    );
  });
});

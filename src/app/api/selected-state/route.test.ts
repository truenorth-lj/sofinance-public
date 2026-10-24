import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/selected-state", () => ({ readSelectedPositionState: vi.fn() }));
vi.mock("@/lib/sentry/capture", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/sentry/capture")>(),
  captureApiRouteError: vi.fn(),
}));

import { readSelectedPositionState } from "@sofinance/engine/selected-state";
import { captureApiRouteError } from "@/lib/sentry/capture";
import { testKeypair } from "@/lib/test-support/send-fixtures";
import { GET } from "./route";

const params = new URLSearchParams({
  wallet: testKeypair(1).publicKey.toBase58(),
  positionMint: testKeypair(2).publicKey.toBase58(),
  inputMint: "So11111111111111111111111111111111111111112",
  inputKind: "native",
});
const request = () => new Request(`http://localhost/api/selected-state?${params}`);

describe("GET /api/selected-state", () => {
  afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

  it("answers 409 position_not_held without reporting it when the wallet no longer holds the NFT", async () => {
    vi.mocked(readSelectedPositionState).mockRejectedValue(new Error("Wallet does not currently hold this Raydium CLMM position NFT"));
    const response = await GET(request());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Wallet does not currently hold this Raydium CLMM position NFT", code: "position_not_held",
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(captureApiRouteError).not.toHaveBeenCalled();
  });

  it("answers 409 input_asset_not_held without reporting it when the wallet has no balance of the input token", async () => {
    vi.mocked(readSelectedPositionState).mockRejectedValue(new Error("Wallet does not have the selected investable asset"));
    const response = await GET(request());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Wallet does not have the selected input asset. Please pick another asset.",
      code: "input_asset_not_held",
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(captureApiRouteError).not.toHaveBeenCalled();
  });

  it("still answers 503 and reports unexpected read failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(readSelectedPositionState).mockRejectedValue(new Error("Pool vault does not exist"));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(captureApiRouteError).toHaveBeenCalledTimes(1);
  });

  it("returns the state on success", async () => {
    vi.mocked(readSelectedPositionState).mockResolvedValue({ ownsNft: true } as never);
    const response = await GET(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ownsNft: true });
  });
});

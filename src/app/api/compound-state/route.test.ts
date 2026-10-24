import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/compound-state", () => ({ readCompoundPositionState: vi.fn() }));
vi.mock("@/lib/sentry/capture", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/sentry/capture")>(),
  captureApiRouteError: vi.fn(),
}));

import { readCompoundPositionState } from "@sofinance/engine/compound-state";
import { RpcUnavailableError } from "@sofinance/engine/rpc/errors";
import { captureApiRouteError } from "@/lib/sentry/capture";
import { testKeypair } from "@/lib/test-support/send-fixtures";
import { POST } from "./route";

const wallet = testKeypair(1).publicKey.toBase58();
const positionMint = testKeypair(2).publicKey.toBase58();
const request = () => new Request("http://localhost/api/compound-state", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wallet, positionMint }),
});

describe("POST /api/compound-state", () => {
  afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

  it("answers a retryable 503 rpc_unavailable (not 400) when the RPC providers rate-limit the read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(readCompoundPositionState).mockRejectedValue(new RpcUnavailableError(new Error("429 Too Many Requests")));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("2");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "Solana RPC is temporarily unavailable. Please retry in a moment.", code: "rpc_unavailable",
    });
    expect(captureApiRouteError).toHaveBeenCalledTimes(1);
  });

  it("keeps other read failures as 400 without the retry code", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(readCompoundPositionState).mockRejectedValue(new Error("Compound boundary tick array does not exist"));
    const response = await POST(request());
    expect(response.status).toBe(400);
    const body = await response.json() as { code?: string };
    expect(body.code).toBeUndefined();
  });

  it("returns the state on success", async () => {
    vi.mocked(readCompoundPositionState).mockResolvedValue({ wallet, positionMint } as never);
    const response = await POST(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ wallet, positionMint });
  });
});

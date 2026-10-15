// Characterization tests for POST /api/transaction-finality (generic signature finality probe).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: vi.fn() }));

import { rpcConnection } from "@sofinance/engine/rpc";
import { fakeConnection, type FakeConnection, jsonRequest } from "@/lib/test-support/send-fixtures";
import { POST } from "./route";

const signature = bs58.encode(new Uint8Array(64).fill(3));
async function call(body: unknown) {
  const response = await POST(jsonRequest("http://localhost/api/transaction-finality", body));
  return { response, json: await response.json() as Record<string, unknown> };
}
let connection: FakeConnection;
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  connection = fakeConnection();
  vi.mocked(rpcConnection).mockReturnValue(connection as never);
});
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });

describe("POST /api/transaction-finality", () => {
  it.each([
    ["not an object", 5], ["array", []], ["null", null],
    ["missing signature", { lastValidBlockHeight: 5 }],
    ["short signature", { signature: bs58.encode(new Uint8Array(32)), lastValidBlockHeight: 5 }],
    ["zero height", { signature, lastValidBlockHeight: 0 }],
    ["fractional height", { signature, lastValidBlockHeight: 1.5 }],
  ])("rejects %s", async (_name, body) => {
    const { response, json } = await call(body);
    expect(response.status).toBe(400);
    expect(json).toEqual({ error: "Invalid transaction verification input" });
  });

  it.each([
    ["finalized without error", { confirmationStatus: "finalized", err: null }, "finalized"],
    ["finalized with error", { confirmationStatus: "finalized", err: { X: 1 } }, "failed"],
    ["confirmed", { confirmationStatus: "confirmed", err: null }, "pending"],
    ["QUIRK: confirmed with an error stays pending until finalized", { confirmationStatus: "confirmed", err: { X: 1 } }, "pending"],
  ])("observed %s => %s", async (_name, observed, status) => {
    connection.getSignatureStatuses.mockResolvedValue({ value: [observed] });
    const { response, json } = await call({ signature, lastValidBlockHeight: 150 });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(json).toEqual({ status });
  });

  it("not found: pending until the CONFIRMED height is strictly greater than lastValidBlockHeight, then expired", async () => {
    connection.getBlockHeight.mockResolvedValue(150);
    expect((await call({ signature, lastValidBlockHeight: 150 })).json).toEqual({ status: "pending" });
    connection.getBlockHeight.mockResolvedValue(151);
    expect((await call({ signature, lastValidBlockHeight: 150 })).json).toEqual({ status: "expired" });
    expect(connection.getBlockHeight).toHaveBeenCalledWith("confirmed");
  });
});

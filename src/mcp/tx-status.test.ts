// tx_status end to end through the real /api/mcp route (no token), dispatch and Zod; only the RPC is faked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMcpRateLimit } from "@/lib/mcp-rate-limit";
import bs58 from "bs58";
import { NextRequest } from "next/server";
vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: vi.fn() }));
import { rpcConnection } from "@sofinance/engine/rpc";
import { fakeConnection, type FakeConnection } from "@/lib/test-support/send-fixtures";
import { POST } from "@/app/api/mcp/route";
import { listToolDefinitions } from "./tool-definitions";

const signature = bs58.encode(new Uint8Array(64).fill(5));
let connection: FakeConnection;
async function call(args: unknown, headers: Record<string, string> = {}) {
  const response = await POST(new NextRequest("http://localhost/api/mcp", {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tx_status", arguments: args } }),
  }));
  const json = await response.json();
  return { response, result: json.result, value: json.result ? JSON.parse(json.result.content[0].text) : undefined };
}
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  connection = fakeConnection();
  vi.mocked(rpcConnection).mockReturnValue(connection as never);
});
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });

describe("tx_status over /api/mcp", () => {
  it("needs no token and reports a confirmed signature at the default commitment", async () => {
    connection.getSignatureStatuses.mockResolvedValue({ value: [{ confirmationStatus: "confirmed", err: null, slot: 321 }] });
    const { response, result, value } = await call({ signature });
    expect(response.status).toBe(200);
    expect(result.isError).toBeUndefined();
    expect(value).toEqual({
      signature, chain: "solana:mainnet", commitment: "confirmed", status: "confirmed", settled: true, slot: 321,
      meaning: expect.stringContaining("confirmed"), explorerUrl: `https://solscan.io/tx/${signature}`,
    });
    expect(connection.getSignatureStatuses).toHaveBeenCalledExactlyOnceWith([signature], { searchTransactionHistory: true });
    expect(connection.getBlockHeight).not.toHaveBeenCalled();
  });

  it("ignores any Authorization header (public tool)", async () => {
    connection.getSignatureStatuses.mockResolvedValue({ value: [{ confirmationStatus: "finalized", err: null, slot: 1 }] });
    const { response, value } = await call({ signature, commitment: "finalized" }, { Authorization: "Bearer not-a-token" });
    expect(response.status).toBe(200);
    expect(value).toMatchObject({ status: "finalized", settled: true, commitment: "finalized" });
  });

  it("failed on-chain is settled", async () => {
    connection.getSignatureStatuses.mockResolvedValue({ value: [{ confirmationStatus: "confirmed", err: { InstructionError: [1, "Custom"] }, slot: 2 }] });
    expect((await call({ signature })).value).toMatchObject({ status: "failed", settled: true });
  });

  it("unseen: unknown without a height, pending then expired with one", async () => {
    expect((await call({ signature })).value).toMatchObject({ status: "unknown", settled: false, slot: null });
    expect(connection.getBlockHeight).not.toHaveBeenCalled();
    connection.getBlockHeight.mockResolvedValue(500);
    expect((await call({ signature, lastValidBlockHeight: 500 })).value).toMatchObject({ status: "pending", settled: false });
    connection.getBlockHeight.mockResolvedValue(501);
    expect((await call({ signature, lastValidBlockHeight: 500 })).value).toMatchObject({ status: "expired", settled: true });
  });

  it.each([
    ["no signature", {}],
    ["a 32-byte value", { signature: bs58.encode(new Uint8Array(32).fill(5)) }],
    ["a non-base58 string", { signature: "0".repeat(88) }],
    ["a zero height", { signature, lastValidBlockHeight: 0 }],
    ["an unknown commitment", { signature, commitment: "processed" }],
  ])("rejects %s without calling the RPC", async (_name, args) => {
    const { response, result } = await call(args);
    expect(response.status).toBe(200);
    expect(result.isError).toBe(true);
    expect(connection.getSignatureStatuses).not.toHaveBeenCalled();
  });

  it("an RPC failure is a tool error, not a guessed status", async () => {
    connection.getSignatureStatuses.mockRejectedValue(new Error("upstream 429 https://rpc.example/?api-key=secret"));
    const { result } = await call({ signature });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain("api-key");
  });

  it("is listed as a read-only, idempotent tool on both transports", () => {
    for (const surface of ["http", "stdio"] as const) {
      const tool = listToolDefinitions(surface).find((candidate) => candidate.name === "tx_status")!;
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
      expect(tool.inputSchema.required).toEqual(["signature"]);
    }
  });
});

// /api/mcp keeps per-IP rate-limit counts in module memory; every test starts with fresh budgets.
beforeEach(() => resetMcpRateLimit());

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { compoundHistoryFixture } from "@/lib/test-support/compound-history-fixture";
import { fakeConnection, jsonRequest } from "@/lib/test-support/send-fixtures";
import { POST } from "./route";

vi.mock("server-only", () => ({}));
const backend = vi.hoisted(() => ({ rpc: vi.fn(), verify: vi.fn() }));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: backend.rpc }));
vi.mock("@sofinance/engine/compound-recovery-import", () => ({ importVerifiedCompoundReceipt: backend.verify }));
beforeEach(() => { vi.resetAllMocks(); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

it("keeps the HTTP receipt projection, no-store header and finalized import through the real registry", async () => {
  const { wallet, attempt, transaction } = compoundHistoryFixture();
  const connection = fakeConnection({ getParsedTransaction: vi.fn(async () => transaction) });
  const receipt = { wallet, positionMint: attempt.positionMint, sourceSignature: attempt.signature, compoundAccounts: [] };
  backend.rpc.mockReturnValue(connection); backend.verify.mockResolvedValue(receipt);
  const response = await POST(jsonRequest("http://localhost/api/compound-recover-import", { wallet, signature: attempt.signature }));
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ receipt });
  expect(response.headers.get("Cache-Control")).toBe("no-store"); expect(backend.rpc).toHaveBeenCalledOnce();
  expect(connection.getParsedTransaction).toHaveBeenCalledExactlyOnceWith(attempt.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
  expect(backend.verify).toHaveBeenCalledExactlyOnceWith(connection, transaction, wallet, attempt.signature);
  expect(connection.sendRawTransaction).not.toHaveBeenCalled();
});

it("keeps wallet/signature rejection before connection creation or history lookup", async () => {
  const { wallet, attempt } = compoundHistoryFixture();
  for (const body of [{ wallet: "invalid", signature: attempt.signature }, { wallet, signature: "short" }, { wallet, signature: 1 }]) {
    const response = await POST(jsonRequest("http://localhost/api/compound-recover-import", body));
    expect(response.status).toBe(400); expect(backend.rpc).not.toHaveBeenCalled(); expect(backend.verify).not.toHaveBeenCalled();
  }
});

it("rejects mismatched RPC transaction identity as HTTP400 before importing any receipt", async () => {
  const { wallet, attempt, transaction } = compoundHistoryFixture();
  transaction.transaction.signatures[0] = "different-signature";
  backend.rpc.mockReturnValue(fakeConnection({ getParsedTransaction: vi.fn(async () => transaction) }));
  const response = await POST(jsonRequest("http://localhost/api/compound-recover-import", { wallet, signature: attempt.signature }));
  expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: "Compound transaction signature mismatch" });
  expect(backend.verify).not.toHaveBeenCalled();
});

it("preserves missing-history and ledger-verification errors as HTTP400 without a success receipt", async () => {
  const { wallet, attempt, transaction } = compoundHistoryFixture(), connection = fakeConnection();
  backend.rpc.mockReturnValue(connection);
  const call = () => POST(jsonRequest("http://localhost/api/compound-recover-import", { wallet, signature: attempt.signature }));
  const missing = await call(); expect(missing.status).toBe(400);
  expect(await missing.json()).toEqual({ error: "Confirmed original compound transaction not yet found" });
  expect(backend.verify).not.toHaveBeenCalled();
  connection.getParsedTransaction.mockResolvedValue(transaction); backend.verify.mockRejectedValueOnce(new Error("Historical yield ledger mismatch"));
  const invalid = await call(); expect(invalid.status).toBe(400); expect(await invalid.json()).toEqual({ error: "Historical yield ledger mismatch" });
  expect(connection.sendRawTransaction).not.toHaveBeenCalled();
});

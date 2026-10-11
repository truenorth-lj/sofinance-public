// Characterization tests for POST /api/compound-confirm. Compare with selected-status: this route
// waits for "finalized" and uses getBlockHeight("finalized"); selected-status accepts "confirmed".
// parseCompoundAttempt (unit-tested elsewhere) and the receipt matchers are mocked to focus on routing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rpc", () => ({ rpcConnection: vi.fn() }));
vi.mock("@/lib/compound-attempt", () => ({ parseCompoundAttempt: vi.fn() }));
vi.mock("@/lib/compound-state", () => ({ readCompoundPositionState: vi.fn() }));
vi.mock("@/lib/compound-receipt", () => ({ confirmedCompoundReceipt: vi.fn(), confirmedRecovery: vi.fn() }));

import { parseCompoundAttempt } from "@/lib/compound-attempt";
import { confirmedCompoundReceipt, confirmedRecovery } from "@/lib/compound-receipt";
import { readCompoundPositionState } from "@/lib/compound-state";
import { rpcConnection } from "@/lib/rpc";
import { fakeConnection, type FakeConnection, jsonRequest, testKeypair } from "@/lib/test-support/send-fixtures";
import { POST } from "./route";

const wallet = testKeypair(1).publicKey.toBase58();
const accountA = testKeypair(30).publicKey.toBase58();
const accountB = testKeypair(31).publicKey.toBase58();
const signature = "S".repeat(10);
const attemptFor = (kind: "compound" | "recovery") => ({
  kind, signature, positionMint: testKeypair(2).publicKey.toBase58(),
  summary: { lastValidBlockHeight: 150, compoundAccounts: [{ address: accountA }, { address: accountB }] },
});

async function call(body: unknown = { wallet, attempt: {} }) {
  const response = await POST(jsonRequest("http://localhost/api/compound-confirm", body));
  return { response, json: await response.json() as Record<string, unknown> };
}

let connection: FakeConnection;
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  connection = fakeConnection({
    getSignatureStatuses: vi.fn(async () => ({ value: [{ confirmationStatus: "finalized", err: null }] })),
    getParsedTransaction: vi.fn(async () => ({ meta: { err: null } })),
  });
  vi.mocked(rpcConnection).mockReturnValue(connection as never);
  vi.mocked(parseCompoundAttempt).mockReturnValue(attemptFor("compound") as never);
  vi.mocked(readCompoundPositionState).mockResolvedValue({ liquidity: "1" } as never);
  vi.mocked(confirmedCompoundReceipt).mockReturnValue({ receipt: true } as never);
  vi.mocked(confirmedRecovery).mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("POST /api/compound-confirm", () => {
  it("rejects an invalid attempt record", async () => {
    vi.mocked(parseCompoundAttempt).mockReturnValue(null);
    const { response, json } = await call();
    expect(response.status).toBe(400);
    expect(json).toEqual({ error: "Invalid compound verification record" });
    expect(rpcConnection).not.toHaveBeenCalled();
  });

  it("rejects an invalid wallet and passes the parsed wallet into the attempt parser", async () => {
    expect((await call({ wallet: "bad", attempt: {} })).json).toEqual({ error: "Invalid wallet address" });
    await call({ wallet, attempt: { x: 1 } });
    expect(parseCompoundAttempt).toHaveBeenLastCalledWith({ x: 1 }, wallet);
  });

  it("QUIRK: rejects bodies over 30,000 chars via the shared compound body reader", async () => {
    const { json } = await call(JSON.stringify({ wallet, attempt: {}, pad: "x".repeat(30_001) }));
    expect(json).toEqual({ error: "Compound request too large" });
  });

  describe("signature not found", () => {
    beforeEach(() => connection.getSignatureStatuses.mockResolvedValue({ value: [null] }));
    it("is pending until the FINALIZED height passes lastValidBlockHeight", async () => {
      connection.getBlockHeight.mockResolvedValue(150);
      expect((await call()).json).toEqual({ signature, state: null, status: "pending" });
      expect(connection.getBlockHeight).toHaveBeenCalledWith("finalized");
    });
    it("compound: expired when every isolated yield account is still absent", async () => {
      connection.getBlockHeight.mockResolvedValue(151);
      connection.getMultipleAccountsInfo.mockResolvedValue([null, null]);
      expect((await call()).json).toMatchObject({ status: "expired" });
    });
    it("compound: manual-review when an isolated yield account exists without transaction evidence", async () => {
      connection.getBlockHeight.mockResolvedValue(151);
      connection.getMultipleAccountsInfo.mockResolvedValue([null, { lamports: 1 }]);
      expect((await call()).json).toMatchObject({ status: "manual-review" });
    });
    it("recovery: expired only when every yield account is STILL present (inverse of compound)", async () => {
      vi.mocked(parseCompoundAttempt).mockReturnValue(attemptFor("recovery") as never);
      connection.getBlockHeight.mockResolvedValue(151);
      connection.getMultipleAccountsInfo.mockResolvedValue([{ lamports: 1 }, { lamports: 1 }]);
      expect((await call()).json).toMatchObject({ status: "expired" });
      connection.getMultipleAccountsInfo.mockResolvedValue([{ lamports: 1 }, null]);
      expect((await call()).json).toMatchObject({ status: "manual-review" });
    });
  });

  it("QUIRK: 'confirmed' is NOT enough here, only 'finalized' proceeds (selected-status accepts confirmed)", async () => {
    connection.getSignatureStatuses.mockResolvedValue({ value: [{ confirmationStatus: "confirmed", err: null }] });
    expect((await call()).json).toEqual({ signature, state: null, status: "pending" });
    expect(connection.getParsedTransaction).not.toHaveBeenCalled();
  });

  it("QUIRK: a failed (err) status that is not yet finalized is still reported pending", async () => {
    connection.getSignatureStatuses.mockResolvedValue({ value: [{ confirmationStatus: "confirmed", err: { X: 1 } }] });
    expect((await call()).json).toMatchObject({ status: "pending" });
  });

  it("finalized with err => failed", async () => {
    connection.getSignatureStatuses.mockResolvedValue({ value: [{ confirmationStatus: "finalized", err: { X: 1 } }] });
    expect((await call()).json).toMatchObject({ status: "failed", transactionError: { X: 1 } });
  });

  it("missing parsed transaction or meta => pending; meta.err => failed", async () => {
    connection.getParsedTransaction.mockResolvedValue(null);
    expect((await call()).json).toMatchObject({ status: "pending" });
    connection.getParsedTransaction.mockResolvedValue({ meta: null });
    expect((await call()).json).toMatchObject({ status: "pending" });
    connection.getParsedTransaction.mockResolvedValue({ meta: { err: { Y: 2 } } });
    expect((await call()).json).toMatchObject({ status: "failed", transactionError: { Y: 2 } });
  });

  it("recovery: success/manual-review from confirmedRecovery", async () => {
    vi.mocked(parseCompoundAttempt).mockReturnValue(attemptFor("recovery") as never);
    expect((await call()).json).toMatchObject({ status: "success" });
    vi.mocked(confirmedRecovery).mockReturnValue(false);
    expect((await call()).json).toMatchObject({ status: "manual-review" });
  });

  it("compound: success with receipt and fresh state", async () => {
    const { response, json } = await call();
    expect(response.status).toBe(200);
    expect(json).toEqual({ signature, state: { liquidity: "1" }, receipt: { receipt: true }, status: "success" });
  });

  it("compound: a state-read failure keeps the receipt (state null) and still succeeds", async () => {
    vi.mocked(readCompoundPositionState).mockRejectedValue(new Error("position gone"));
    expect((await call()).json).toEqual({ signature, state: null, receipt: { receipt: true }, status: "success" });
  });

  it("compound: no receipt => manual-review and state is NOT read", async () => {
    vi.mocked(confirmedCompoundReceipt).mockReturnValue(null as never);
    const { json } = await call();
    expect(json).toMatchObject({ status: "manual-review", state: null });
    expect(readCompoundPositionState).not.toHaveBeenCalled();
  });
});

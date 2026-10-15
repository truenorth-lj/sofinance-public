import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: vi.fn() }));
vi.mock("@sofinance/engine/compound-state", () => ({ readCompoundPositionState: vi.fn() }));
import { rpcConnection } from "@sofinance/engine/rpc";
import { readCompoundPositionState } from "@sofinance/engine/compound-state";
import { compoundHistoryFixture } from "@/lib/test-support/compound-history-fixture";
import { fakeConnection, jsonRequest } from "@/lib/test-support/send-fixtures";
import { POST } from "./route";

afterEach(() => vi.resetAllMocks());
describe("historical compound confirmation with real attempt and receipt validation", () => {
  it("reconciles harvest, swap, protocol fee and liquidity despite missing old signature status", async () => {
    const { wallet, attempt, transaction, state } = compoundHistoryFixture(Date.now() - 86_400_000);
    const connection = fakeConnection({ getParsedTransaction: vi.fn(async () => transaction) });
    vi.mocked(rpcConnection).mockReturnValue(connection as never);
    vi.mocked(readCompoundPositionState).mockResolvedValue(state);
    const response = await POST(jsonRequest("http://localhost/api/compound-confirm", { wallet, attempt }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "success", chainStatus: "success", signature: attempt.signature,
      receipt: { harvestedA: "478017", harvestedB: "171", investedA: "379610", investedB: "986",
        remainingA: "13092", remainingB: "34", liquidityAdded: "15948943" } });
    expect(connection.getParsedTransaction).toHaveBeenCalledWith(attempt.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    expect(connection.getMultipleAccountsInfo).not.toHaveBeenCalled();
  });
  it("retains a ledger warning without an execution lock when historical metadata is inconsistent", async () => {
    const { wallet, attempt, transaction } = compoundHistoryFixture();
    transaction.meta!.postTokenBalances![1]!.uiTokenAmount.amount = "13093";
    vi.mocked(rpcConnection).mockReturnValue(fakeConnection({ getParsedTransaction: vi.fn(async () => transaction) }) as never);
    const response = await POST(jsonRequest("http://localhost/api/compound-confirm", { wallet, attempt }));
    expect(await response.json()).toMatchObject({ status: "manual-review", chainStatus: "success", receipt: null });
    expect(readCompoundPositionState).not.toHaveBeenCalled();
  });
});

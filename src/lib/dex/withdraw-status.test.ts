import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { withdrawPermit } from "@sofinance/engine/withdraw/permit";
import { readWithdrawalStatus, type WithdrawalStatusCommand } from "./index";
import { createDexRegistry } from "./registry";
import { raydiumClmmModule } from "./raydium-clmm/module";
import { POST } from "@/app/api/withdraw-status/route";
import { SIGNING_SECRET, appendWalletExtraInstruction, buildTransaction, jsonRequest, messageBase64, signatureOf, testKeypair, toBase64 } from "@/lib/test-support/send-fixtures";

vi.mock("server-only", () => ({}));
const backend = vi.hoisted(() => ({ rpc: vi.fn(), secret: vi.fn(), invalidate: vi.fn(), reset: vi.fn() }));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: backend.rpc, resetRpcCache: backend.reset }));
vi.mock("@sofinance/engine/config/server-env", async original => ({
  ...await original<typeof import("@sofinance/engine/config/server-env")>(), getSigningSecret: backend.secret,
}));
vi.mock("@/lib/position-history-cache", () => ({ invalidatePositionHistoryCache: backend.invalidate }));

function authorize(command: WithdrawalStatusCommand) {
  const expected = VersionedTransaction.deserialize(Buffer.from(command.prepared.unsignedTransaction, "base64"));
  command.prepared.permit = withdrawPermit.issue(SIGNING_SECRET, {
    wallet: command.prepared.summary.wallet, message: messageBase64(expected), summary: command.prepared.summary,
  });
}
function fixture() {
  const payer = testKeypair(1), transaction = buildTransaction({ payer });
  const command: WithdrawalStatusCommand = { signature: signatureOf(transaction), prepared: {
    unsignedTransaction: toBase64(transaction), permit: "", summary: {
      wallet: payer.publicKey.toBase58(), operation: "withdraw", stage: "atomic", positionMint: testKeypair(2).publicKey.toBase58(),
      positionAccount: testKeypair(3).publicKey.toBase58(), poolId: testKeypair(4).publicKey.toBase58(), percentBps: 5000,
      receive: "original", transactions: 1, closesPosition: false, startingLiquidity: "100", removedLiquidity: "50",
      assets: [], outputs: [], priceImpactBps: 0, warning: false, requiresSecondConfirmation: false, slippageBps: 100,
      protocolFee: { bps: 0, wallet: null, legs: [] }, rentRefundLamports: "0", maxSolDebitLamports: "10000000",
      expiresAt: 1, lastValidBlockHeight: 150, blockhash: transaction.message.recentBlockhash, bytes: transaction.serialize().length,
    },
  } };
  authorize(command);
  const receipt = { meta: { err: null }, transaction: { message: transaction.message, signatures: [command.signature] } };
  const connection = { getSignatureStatuses: vi.fn().mockResolvedValue({ value: [{ confirmationStatus: "finalized", err: null }] }),
    getBlockHeight: vi.fn().mockResolvedValue(100), getTransaction: vi.fn().mockResolvedValue(receipt),
    getMultipleAccountsInfo: vi.fn(), sendRawTransaction: vi.fn() };
  backend.rpc.mockReturnValue(connection);
  return { command, connection, receipt, transaction };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { vi.resetAllMocks(); backend.secret.mockReturnValue(SIGNING_SECRET); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

it("captures signature and complete authorization before lazy/RPC awaits and invalidates only the initiating position", async () => {
  const { command, connection } = fixture(), original = structuredClone(command), gate = deferred<unknown>(), started = deferred<void>();
  connection.getSignatureStatuses.mockImplementation(async () => { started.resolve(); return gate.promise; });
  const pending = readWithdrawalStatus("raydium-clmm", command);
  command.signature = signatureOf(buildTransaction({ payer: testKeypair(8) }));
  command.prepared.summary.wallet = "other"; command.prepared.summary.positionMint = "other";
  command.prepared.permit = "bad"; command.prepared.unsignedTransaction = "bad";
  await started.promise;
  gate.resolve({ value: [{ confirmationStatus: "finalized", err: null }] });
  expect(await pending).toEqual({ status: "success", signature: original.signature, stage: "atomic" });
  expect(backend.secret).toHaveBeenCalledOnce(); expect(backend.rpc).toHaveBeenCalledOnce();
  expect(connection.getSignatureStatuses).toHaveBeenCalledExactlyOnceWith([original.signature], { searchTransactionHistory: true });
  expect(connection.getTransaction).toHaveBeenCalledExactlyOnceWith(original.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
  expect(backend.invalidate).toHaveBeenCalledExactlyOnceWith(original.prepared.summary.positionMint);
  expect(backend.reset).toHaveBeenCalledOnce(); expect(connection.sendRawTransaction).not.toHaveBeenCalled();
});

it("reconciles expired authorizations even when new withdrawal preparation and generic HTTP are disabled", async () => {
  const { command } = fixture(), descriptor = raydiumClmmModule.descriptor;
  const registry = createDexRegistry([{ ...raydiumClmmModule, descriptor: { ...descriptor, nativeCapabilities: {
    ...descriptor.nativeCapabilities!, positions: { ...descriptor.nativeCapabilities!.positions,
      withdraw: { supported: false, reason: "New withdrawals unavailable" } },
  } } }]);
  await expect(registry.readWithdrawalStatus("raydium-clmm", command)).resolves.toHaveProperty("status", "success");
  expect(registry.isDisabled("raydium-clmm", "withdraw")).toBe(true);
});

it.each([true, false])("HTTP keeps wrong/missing receipt signatures in manual review without cache or account effects (indexed=%s)", async indexed => {
  const { command, connection, receipt, transaction } = fixture();
  connection.getSignatureStatuses.mockResolvedValue({ value: [indexed ? { confirmationStatus: "finalized", err: null } : null] });
  connection.getBlockHeight.mockResolvedValue(151);
  const alternate = appendWalletExtraInstruction(transaction); alternate.sign([testKeypair(1)]);
  for (const signatures of [[signatureOf(alternate)], []]) {
    connection.getTransaction.mockResolvedValue({ ...receipt, meta: { err: { InstructionError: [0, "failed"] } },
      transaction: { ...receipt.transaction, message: alternate.message, signatures } });
    const response = await POST(jsonRequest("http://localhost/api/withdraw-status", command));
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ status: "manual-review", signature: command.signature });
  }
  expect(backend.invalidate).not.toHaveBeenCalled(); expect(backend.reset).not.toHaveBeenCalled();
  expect(connection.getMultipleAccountsInfo).not.toHaveBeenCalled(); expect(connection.sendRawTransaction).not.toHaveBeenCalled();
});

it("validates signature then permit before any RPC and preserves HTTP400 failures", async () => {
  const { command } = fixture();
  const malformed = await POST(jsonRequest("http://localhost/api/withdraw-status", { ...command, signature: "short" }));
  expect(malformed.status).toBe(400); expect(backend.secret).not.toHaveBeenCalled(); expect(backend.rpc).not.toHaveBeenCalled();
  command.prepared.permit = "0".repeat(64);
  const unauthorized = await POST(jsonRequest("http://localhost/api/withdraw-status", command));
  expect(unauthorized.status).toBe(400); expect(await unauthorized.json()).toEqual({ error: "Invalid withdrawal authorization" });
  expect(backend.secret).toHaveBeenCalledOnce(); expect(backend.rpc).not.toHaveBeenCalled();
});

it("preserves pending, manual review and failure handling for the queried finalized receipt", async () => {
  const { command, connection, receipt } = fixture();
  for (const [value, status] of [[null, "pending"], [{ ...receipt, meta: null }, "manual-review"],
    [{ ...receipt, meta: { err: { InstructionError: [0, "failed"] } } }, "failed"]] as const) {
    connection.getTransaction.mockResolvedValue(value);
    await expect(readWithdrawalStatus("raydium-clmm", command)).resolves.toHaveProperty("status", status);
  }
  expect(backend.invalidate).not.toHaveBeenCalled(); expect(backend.reset).not.toHaveBeenCalled();
});

it("uses finalized unchanged-account evidence only when history is genuinely absent", async () => {
  const { command, connection } = fixture(), owner = new PublicKey(command.prepared.summary.wallet), mint = testKeypair(11).publicKey;
  const account = testKeypair(12).publicKey;
  command.prepared.summary.stage = "swap";
  command.prepared.summary.assets = [{ mint: mint.toBase58(), account: account.toBase58(), program: TOKEN_PROGRAM_ID.toBase58(),
    decimals: 6, starting: "100", amount: "50" }]; authorize(command);
  const data = Buffer.alloc(165); mint.toBuffer().copy(data); owner.toBuffer().copy(data, 32); data.writeBigUInt64LE(100n, 64); data[108] = 1;
  connection.getSignatureStatuses.mockResolvedValue({ value: [null] }); connection.getBlockHeight.mockResolvedValue(151);
  connection.getTransaction.mockResolvedValue(null); connection.getMultipleAccountsInfo.mockResolvedValue([{ data, owner: TOKEN_PROGRAM_ID }, null]);
  await expect(readWithdrawalStatus("raydium-clmm", command)).resolves.toHaveProperty("status", "expired");
  expect(connection.getBlockHeight).toHaveBeenCalledWith("confirmed");
  expect(connection.getMultipleAccountsInfo).toHaveBeenCalledWith([account, new PublicKey(command.prepared.summary.positionAccount)], "finalized");
  data.writeBigUInt64LE(99n, 64);
  await expect(readWithdrawalStatus("raydium-clmm", command)).resolves.toHaveProperty("status", "manual-review");
  expect(backend.invalidate).not.toHaveBeenCalled(); expect(backend.reset).not.toHaveBeenCalled();
});

it("propagates RPC failure unchanged and requires explicit status bindings", async () => {
  const { command, connection } = fixture(), error = new Error("History RPC unavailable");
  connection.getSignatureStatuses.mockRejectedValueOnce(error);
  await expect(readWithdrawalStatus("raydium-clmm", command)).rejects.toBe(error);
  expect(backend.invalidate).not.toHaveBeenCalled(); expect(backend.reset).not.toHaveBeenCalled();
  const absent = createDexRegistry([{ descriptor: raydiumClmmModule.descriptor }]);
  for (const id of ["raydium-clmm", "unknown"]) {
    await expect(absent.readWithdrawalStatus(id, command)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  }
});

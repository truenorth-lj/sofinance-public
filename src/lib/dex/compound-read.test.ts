import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Connection } from "@solana/web3.js";
import { createDexRegistry } from "./registry";
import { raydiumClmmModule } from "./raydium-clmm/module";
import { compoundHistoryFixture } from "@/lib/test-support/compound-history-fixture";
import { fakeConnection } from "@/lib/test-support/send-fixtures";

vi.mock("server-only", () => ({}));
const backend = vi.hoisted(() => ({ state: vi.fn(), import: vi.fn(), invalidate: vi.fn(), reset: vi.fn() }));
vi.mock("@sofinance/engine/compound-state", () => ({ readCompoundPositionState: backend.state }));
vi.mock("@sofinance/engine/compound-recovery-import", () => ({ importVerifiedCompoundReceipt: backend.import }));
vi.mock("@/lib/position-history-cache", () => ({ invalidatePositionHistoryCache: backend.invalidate }));
vi.mock("@sofinance/engine/rpc/cache", () => ({ resetRpcCache: backend.reset }));

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function registry() {
  const descriptor = raydiumClmmModule.descriptor;
  return createDexRegistry([{ ...raydiumClmmModule, descriptor: { ...descriptor, nativeCapabilities: {
    ...descriptor.nativeCapabilities!, positions: { ...descriptor.nativeCapabilities!.positions,
      compound: { supported: false, reason: "New compound preparation unavailable" } },
  } } }]);
}
beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

it("keeps historical finalized evidence, nested attempt identity and cache effects across lazy/RPC awaits with new compound disabled", async () => {
  const f = compoundHistoryFixture(), gate = deferred<void>(), started = deferred<void>();
  const expected = structuredClone(f.attempt), originalWallet = f.wallet;
  const connection = fakeConnection({
    getSignatureStatuses: vi.fn(async () => { started.resolve(); await gate.promise; return { value: [null] }; }),
    getParsedTransaction: vi.fn(async () => f.transaction),
  });
  backend.state.mockResolvedValue(f.state);
  const command = { wallet: f.wallet, attempt: f.attempt }, dex = registry();
  const pending = dex.confirmCompound("raydium-clmm", command, connection as unknown as Connection);
  command.wallet = "other"; command.attempt.signature = "other-signature";
  command.attempt.positionMint = "other-position"; command.attempt.summary.compoundAccounts[0].address = "other-account";
  await started.promise; gate.resolve();
  const result = await pending;
  expect(result).toMatchObject({ signature: expected.signature, status: "success", chainStatus: "success",
    receipt: { harvestedA: "478017", harvestedB: "171", investedA: "379610", investedB: "986", liquidityAdded: "15948943" } });
  expect(connection.getSignatureStatuses).toHaveBeenCalledExactlyOnceWith([expected.signature], { searchTransactionHistory: true });
  expect(connection.getParsedTransaction).toHaveBeenCalledExactlyOnceWith(expected.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
  expect(backend.state).toHaveBeenCalledExactlyOnceWith(originalWallet, expected.positionMint, connection);
  expect(backend.invalidate).toHaveBeenCalledExactlyOnceWith(expected.positionMint); expect(backend.reset).toHaveBeenCalledOnce();
  expect(connection.sendRawTransaction).not.toHaveBeenCalled(); expect(dex.isDisabled("raydium-clmm", "compound")).toBe(true);
});

it("preserves a read-only state's connection, exact engine arguments and raw error identity", async () => {
  const { wallet, attempt, state } = compoundHistoryFixture(), connection = {} as Connection;
  const command = { wallet, positionMint: attempt.positionMint }, expected = { ...command };
  backend.state.mockResolvedValueOnce(state);
  const pending = registry().readCompoundState("raydium-clmm", command, connection);
  command.wallet = "other"; command.positionMint = "other";
  expect(await pending).toBe(state);
  expect(backend.state).toHaveBeenCalledExactlyOnceWith(expected.wallet, expected.positionMint, connection);
  const error = new Error("RPC unavailable"); backend.state.mockRejectedValueOnce(error);
  await expect(registry().readCompoundState("raydium-clmm", expected, connection)).rejects.toBe(error);
});

it("imports only the requested finalized transaction and captures wallet/signature before lazy history lookup", async () => {
  const { wallet, attempt, transaction } = compoundHistoryFixture(), gate = deferred<void>(), started = deferred<void>();
  const connection = fakeConnection({ getParsedTransaction: vi.fn(async () => { started.resolve(); await gate.promise; return transaction; }) });
  const command = { wallet, signature: attempt.signature }, original = { ...command }, receipt = { wallet };
  backend.import.mockResolvedValue(receipt);
  const pending = registry().importCompoundReceipt("raydium-clmm", command, connection as unknown as Connection);
  command.wallet = "other"; command.signature = "other";
  await started.promise; gate.resolve(); expect(await pending).toBe(receipt);
  expect(connection.getParsedTransaction).toHaveBeenCalledExactlyOnceWith(original.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
  expect(backend.import).toHaveBeenCalledExactlyOnceWith(connection, transaction, original.wallet, original.signature);
  expect(connection.sendRawTransaction).not.toHaveBeenCalled(); expect(backend.invalidate).not.toHaveBeenCalled();
});

it("fails closed on missing history or import verification failure without suppressing errors", async () => {
  const { wallet, attempt, transaction } = compoundHistoryFixture(), connection = fakeConnection();
  const command = { wallet, signature: attempt.signature }, dex = registry();
  await expect(dex.importCompoundReceipt("raydium-clmm", command, connection as unknown as Connection))
    .rejects.toThrow("Confirmed original compound transaction not yet found");
  expect(backend.import).not.toHaveBeenCalled();
  connection.getParsedTransaction.mockResolvedValue(transaction);
  const error = new Error("Historical yield ledger mismatch"); backend.import.mockRejectedValueOnce(error);
  await expect(dex.importCompoundReceipt("raydium-clmm", command, connection as unknown as Connection)).rejects.toBe(error);
  expect(connection.sendRawTransaction).not.toHaveBeenCalled(); expect(backend.invalidate).not.toHaveBeenCalled();
});

it("rejects a different transaction returned for the requested signature before importing a receipt", async () => {
  const { wallet, attempt, transaction } = compoundHistoryFixture();
  transaction.transaction.signatures[0] = "different-signature";
  const connection = fakeConnection({ getParsedTransaction: vi.fn(async () => transaction) });
  backend.import.mockResolvedValue({ wallet, sourceSignature: attempt.signature });
  await expect(registry().importCompoundReceipt("raydium-clmm", { wallet, signature: attempt.signature }, connection as unknown as Connection))
    .rejects.toThrow("Compound transaction signature mismatch");
  expect(backend.import).not.toHaveBeenCalled(); expect(connection.sendRawTransaction).not.toHaveBeenCalled();
});

it("requires explicit readback bindings for known or unknown DEX ids", async () => {
  const { wallet, attempt } = compoundHistoryFixture(), connection = {} as Connection;
  const dex = createDexRegistry([{ descriptor: raydiumClmmModule.descriptor }]);
  for (const id of ["raydium-clmm", "unknown"]) {
    await expect(dex.readCompoundState(id, { wallet, positionMint: attempt.positionMint }, connection)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(dex.confirmCompound(id, { wallet, attempt }, connection)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(dex.importCompoundReceipt(id, { wallet, signature: attempt.signature }, connection)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  }
});

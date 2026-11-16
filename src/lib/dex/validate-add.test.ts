import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Connection } from "@solana/web3.js";
import type { SelectedPositionState } from "@sofinance/engine/selected-types";
import { createDexRegistry } from "./registry";
import { fakeSolanaModule } from "./__contract__/testing/fake-dex";
import { APP_SELECTED_SUBMIT, MCP_SELECTED_SUBMIT, type SelectedSubmitCommand } from "./add-submit";
import { submitSelected } from "@/server/transactions/selected-submit";
import { buildTransaction, messageBase64, signatureOf, testKeypair } from "@/lib/test-support/send-fixtures";

vi.mock("server-only", () => ({}));
const backend = vi.hoisted(() => ({ rpc: vi.fn(), state: vi.fn(), simulate: vi.fn(), invalidate: vi.fn() }));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: backend.rpc }));
vi.mock("@sofinance/engine/selected-state", () => ({ readSelectedPositionState: backend.state }));
vi.mock("@/lib/selected-simulation", () => ({ simulateAndVerifySelectedTransaction: backend.simulate }));
vi.mock("@/lib/position-history-cache", () => ({ invalidatePositionHistoryCache: backend.invalidate }));

function fixture() {
  const payer = testKeypair(1), transaction = buildTransaction({ payer });
  const command: SelectedSubmitCommand = { transaction, wallet: payer.publicKey,
    walletSignature: transaction.signatures[0]!.slice(), prepared: buildTransaction({ payer }),
    permitInput: { message: messageBase64(transaction), wallet: payer.publicKey.toBase58(),
      selection: { positionMint: testKeypair(2).publicKey.toBase58(), inputMint: testKeypair(3).publicKey.toBase58(), inputKind: "token" },
      requested: "9007199254740993", expectedLiquidity: "5", startingLiquidity: "10", floorBps: 9900,
      rangeSide: "inside", startingBalances: { input: "9007199254740993", a: "10", b: "5" },
      lastValidBlockHeight: 150, expiresAt: Date.now() + 60000 } };
  const input = command.permitInput;
  // Synthetic reader output; these tests mock simulation, while MCP contract tests exercise its real account checks.
  const state: SelectedPositionState = { ...input.selection, ownsNft: true, paused: false, frozen: false, transferFee: false,
    unsupportedExtensions: [], sufficientSol: true, liquidity: input.startingLiquidity, rangeSide: "inside",
    balances: { ...input.startingBalances }, wsolBalance: "0", wallet: input.wallet, slot: 42, fetchedAt: Date.now(),
    positionAccount: "position-account", poolId: "pool", programId: "program", inputDecimals: 6,
    inputBalance: input.startingBalances.input, inputAccount: "input-ata", inputTokenProgram: "token-program",
    nftAta: "nft-ata", nftProgram: "token-program", mintA: "mint-a", mintB: "mint-b", programA: "token-program",
    programB: "token-program", ataA: "ata-a", ataB: "ata-b", ataAExists: true, ataBExists: true,
    vaultA: "vault-a", vaultB: "vault-b", tickLower: -100, tickUpper: 100, tickSpacing: 1, decimalsA: 6, decimalsB: 6,
    solLamports: 100000000, sqrtPriceX64: "18446744073709551616", tickCurrent: 0, lowerSqrtX64: "1", upperSqrtX64: "2",
    price: "1", inRange: true, poolLiquidity: "10000", currentAmounts: { a: "10", b: "5" }, pricing: undefined };
  const height = vi.fn().mockResolvedValue(100), send = vi.fn().mockResolvedValue(signatureOf(transaction));
  const connection = { getBlockHeight: height, sendRawTransaction: send } as unknown as Connection;
  backend.rpc.mockReturnValue(connection); backend.state.mockResolvedValue(state); backend.simulate.mockResolvedValue({});
  return { command, state, connection, height, send };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

it("keeps validation available for signed operations when new deposits and generic HTTP are disabled", async () => {
  const { command, connection } = fixture(), gate = deferred<void>();
  const expected = structuredClone(command.permitInput);
  const binding = vi.fn(async (input, rpc, profile) => {
    await gate.promise;
    expect(input.permitInput).toEqual(expected);
    expect(input.transaction).toBe(command.transaction); expect(input.prepared).toBe(command.prepared);
    expect(input.wallet).toBe(command.wallet); expect(rpc).toBe(connection); expect(profile).toBe(MCP_SELECTED_SUBMIT);
  });
  const dexModule = { ...fakeSolanaModule, enabled: () => false, validateSignedAdd: binding,
    descriptor: { ...fakeSolanaModule.descriptor, nativeCapabilities: { open: fakeSolanaModule.descriptor.capabilities.open,
      positions: { ...fakeSolanaModule.descriptor.capabilities, deposit: { supported: false as const, reason: "Disabled" } } } } };
  const registry = createDexRegistry([dexModule]);
  const pending = registry.validateSignedAdd(dexModule.descriptor.id, command, connection, MCP_SELECTED_SUBMIT);
  command.permitInput.wallet = "other"; command.permitInput.selection.positionMint = "other";
  command.permitInput.startingBalances.input = "0";
  gate.resolve(); await pending;
  expect(binding).toHaveBeenCalledOnce(); expect(registry.isDisabled(dexModule.descriptor.id, "add")).toBe(true);
  for (const id of [dexModule.descriptor.id, "unknown"]) {
    await expect(createDexRegistry([fakeSolanaModule]).validateSignedAdd(id, command, connection, MCP_SELECTED_SUBMIT))
      .rejects.toMatchObject({ code: "UNSUPPORTED" });
  }
});

it.each([APP_SELECTED_SUBMIT, MCP_SELECTED_SUBMIT] as const)("preserves %s state/simulation policy and signed bytes through the real lazy registry", async profile => {
  const { command, state, connection, send } = fixture();
  const bytes = command.transaction.serialize(), signature = signatureOf(command.transaction);
  expect(await submitSelected(command, profile)).toBe(signature);
  expect(backend.rpc).toHaveBeenCalledOnce();
  expect(backend.state).toHaveBeenCalledWith(command.permitInput.wallet, command.permitInput.selection, connection,
    ...(profile === APP_SELECTED_SUBMIT ? [false, { displayPrices: false }] : []));
  expect(backend.simulate).toHaveBeenCalledWith({ connection, transaction: command.transaction, wallet: command.wallet,
    state, requested: 9007199254740993n, expectedLiquidity: 5n, sigVerify: true, prepared: command.prepared,
    ...(profile === APP_SELECTED_SUBMIT ? { useStateSnapshot: true } : {}) });
  expect(send).toHaveBeenCalledExactlyOnceWith(bytes, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
  expect(command.transaction.serialize()).toEqual(bytes);
  expect(backend.invalidate).toHaveBeenCalledExactlyOnceWith(command.permitInput.selection.positionMint);
});

it("captures permit facts and expected signature across lazy load, concurrent reads and simulation awaits", async () => {
  const { command, state, height, send } = fixture();
  const original = structuredClone(command.permitInput), signature = signatureOf(command.transaction), bytes = command.transaction.serialize();
  const read = deferred<SelectedPositionState>(), started = deferred<void>(), simulation = deferred<void>(), simStarted = deferred<void>();
  backend.state.mockImplementation(async () => { started.resolve(); return read.promise; });
  backend.simulate.mockImplementation(async () => { simStarted.resolve(); return simulation.promise; });
  const pending = submitSelected(command, MCP_SELECTED_SUBMIT);
  command.permitInput.wallet = "other"; command.permitInput.selection.positionMint = "other";
  command.permitInput.startingBalances.input = "0"; command.walletSignature.fill(0);
  await started.promise;
  expect(height).toHaveBeenCalledExactlyOnceWith("confirmed"); expect(send).not.toHaveBeenCalled();
  read.resolve(state); await simStarted.promise;
  command.permitInput.requested = "0"; command.permitInput.expectedLiquidity = "999";
  command.permitInput.lastValidBlockHeight = 0; command.permitInput.expiresAt = 0;
  simulation.resolve(); expect(await pending).toBe(signature);
  expect(backend.state.mock.calls[0]![0]).toBe(original.wallet);
  expect(backend.simulate.mock.calls[0]![0].requested).toBe(BigInt(original.requested));
  expect(backend.simulate.mock.calls[0]![0].expectedLiquidity).toBe(BigInt(original.expectedLiquidity));
  expect(send.mock.calls[0]![0]).toEqual(bytes);
  expect(backend.invalidate).toHaveBeenCalledExactlyOnceWith(original.selection.positionMint);
});

it("retains height, native-WSOL and changed-state error precedence before simulation or send", async () => {
  const { command, state, height, send } = fixture();
  command.permitInput.selection.inputKind = "native"; state.inputKind = "native"; state.wsolBalance = "1"; state.liquidity = "11";
  height.mockResolvedValueOnce(151);
  await expect(submitSelected(command, APP_SELECTED_SUBMIT)).rejects.toThrow("Transaction blockhash expired");
  await expect(submitSelected(command, APP_SELECTED_SUBMIT)).rejects.toThrow("Native SOL input already has WSOL ATA balance");
  state.wsolBalance = "0";
  await expect(submitSelected(command, APP_SELECTED_SUBMIT)).rejects.toThrow("Selected NFT, range, liquidity, or wallet balance has changed");
  await expect(submitSelected(command, MCP_SELECTED_SUBMIT)).rejects.toThrow("Position, liquidity, or wallet balance has changed since preparation");
  expect(backend.simulate).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(backend.invalidate).not.toHaveBeenCalled();
});

it("propagates read and simulation failures unchanged before any send", async () => {
  const { command, send, state } = fixture(), error = new Error("I/O failure");
  backend.state.mockRejectedValueOnce(error);
  await expect(submitSelected(command, MCP_SELECTED_SUBMIT)).rejects.toBe(error);
  expect(backend.simulate).not.toHaveBeenCalled();
  backend.state.mockResolvedValue(state); backend.simulate.mockRejectedValueOnce(error);
  await expect(submitSelected(command, MCP_SELECTED_SUBMIT)).rejects.toBe(error);
  expect(send).not.toHaveBeenCalled(); expect(backend.invalidate).not.toHaveBeenCalled();
});

it("preserves an ambiguous send error without a local resend or cache invalidation", async () => {
  const { command, send } = fixture(), error = new Error("socket timed out after send");
  send.mockRejectedValueOnce(error);
  await expect(submitSelected(command, MCP_SELECTED_SUBMIT)).rejects.toBe(error);
  expect(send).toHaveBeenCalledOnce(); expect(backend.invalidate).not.toHaveBeenCalled();
});

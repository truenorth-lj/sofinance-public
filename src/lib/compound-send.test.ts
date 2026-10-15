// Characterization tests for lib/compound-send.ts (re-verify + broadcast of a signed compound tx).
// Real: CompoundSendError wrapping, isPreflightOrUnsentFailure classification. Mocked: RPC, state
// reader, simulation, Beam lookup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: vi.fn() }));
vi.mock("@sofinance/engine/compound-state", () => ({ readCompoundPositionState: vi.fn() }));
vi.mock("@sofinance/engine/compound-simulation", () => ({ simulateAndVerifyCompound: vi.fn() }));
vi.mock("@sofinance/engine/solami-beam", () => ({ lookupBeamAfterSend: vi.fn() }));

import type { VersionedTransaction } from "@solana/web3.js";
import { readCompoundPositionState } from "@sofinance/engine/compound-state";
import { simulateAndVerifyCompound } from "@sofinance/engine/compound-simulation";
import type { CompoundSummary } from "@sofinance/engine/compound-types";
import { CompoundSendError, reverifySignedCompound, sendSignedCompoundTransaction } from "./compound-send";
import { rpcConnection } from "@sofinance/engine/rpc";
import { lookupBeamAfterSend } from "@sofinance/engine/solami-beam";
import {
  BEAM_RESULT, BLOCKHASH, buildTransaction, compoundSummaryFixture, fakeConnection, type FakeConnection, signatureOf, testKeypair,
} from "./test-support/send-fixtures";

const walletKey = testKeypair(1);
const wallet = walletKey.publicKey.toBase58();
const summaryFor = (overrides: Record<string, unknown> = {}) =>
  ({ ...compoundSummaryFixture({ wallet, blockhash: BLOCKHASH }), ...overrides }) as unknown as CompoundSummary;
const stateMatching = (summary: CompoundSummary, overrides: Record<string, unknown> = {}) => ({
  ...summary.state, liquidity: summary.startingLiquidity, ...overrides,
});

let connection: FakeConnection;
let transaction: VersionedTransaction;
beforeEach(() => {
  transaction = buildTransaction({ payer: walletKey });
  connection = fakeConnection({ sendRawTransaction: vi.fn(async () => signatureOf(transaction)) });
  vi.mocked(rpcConnection).mockReturnValue(connection as never);
  vi.mocked(readCompoundPositionState).mockImplementation(async () => stateMatching(summaryFor()) as never);
  vi.mocked(simulateAndVerifyCompound).mockResolvedValue({ rewards: [] } as never);
  vi.mocked(lookupBeamAfterSend).mockResolvedValue(BEAM_RESULT as never);
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

async function failure(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(CompoundSendError);
  return error as CompoundSendError;
}

describe("sendSignedCompoundTransaction: happy path", () => {
  it("re-reads state, simulates with sigVerify, broadcasts with fixed options and returns the beam fields", async () => {
    const summary = summaryFor();
    const result = await sendSignedCompoundTransaction(wallet, transaction, summary);
    expect(result).toEqual({
      signature: signatureOf(transaction), beam: BEAM_RESULT.beam, beamLabel: "Beam landed", beamLandingUrl: BEAM_RESULT.beamLandingUrl,
    });
    expect(readCompoundPositionState).toHaveBeenCalledWith(wallet, summary.positionMint, connection);
    expect(simulateAndVerifyCompound).toHaveBeenCalledWith(expect.objectContaining({
      connection, expectedLiquidity: 1200n, maxSolDebitLamports: 9_000_000n, sigVerify: true,
    }));
    expect(connection.sendRawTransaction).toHaveBeenCalledWith(expect.any(Uint8Array), {
      skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3,
    });
  });
});

describe("sendSignedCompoundTransaction: pre-broadcast failures claim sent:false", () => {
  it("blockhash expired", async () => {
    connection.getBlockHeight.mockResolvedValue(151);
    const error = await failure(sendSignedCompoundTransaction(wallet, transaction, summaryFor()));
    expect(error.cause).toEqual(new Error("Compound blockhash expired"));
    expect(error.sent).toBe(false);
  });

  it.each<[string, Record<string, unknown>]>([
    ["position not eligible", { eligible: false }],
    ["position account changed", { positionAccount: testKeypair(90).publicKey.toBase58() }],
    ["pool changed", { poolId: testKeypair(90).publicKey.toBase58() }],
    ["tickLower changed", { tickLower: -120 }],
    ["tickUpper changed", { tickUpper: 120 }],
    ["liquidity changed", { liquidity: "1001" }],
    ["mintA changed", { mintA: testKeypair(90).publicKey.toBase58() }],
    ["mintB changed", { mintB: testKeypair(90).publicKey.toBase58() }],
    ["programA changed", { programA: testKeypair(90).publicKey.toBase58() }],
    ["programB changed", { programB: testKeypair(90).publicKey.toBase58() }],
    ["nftAta changed", { nftAta: testKeypair(90).publicKey.toBase58() }],
    ["rangeSide changed", { rangeSide: "above" }],
  ])("state changed: %s", async (_name, stateOverride) => {
    const summary = summaryFor();
    vi.mocked(readCompoundPositionState).mockResolvedValue(stateMatching(summary, stateOverride) as never);
    const error = await failure(sendSignedCompoundTransaction(wallet, transaction, summary));
    expect(error.cause).toEqual(new Error("Compound position identity, liquidity, or availability status has changed"));
    expect(error.sent).toBe(false);
    expect(simulateAndVerifyCompound).not.toHaveBeenCalled();
  });

  it("a positive third-reward amount blocks the send ('cannot fully reinvest')", async () => {
    vi.mocked(simulateAndVerifyCompound).mockResolvedValue({ rewards: [{ amount: "0" }, { amount: "1" }] } as never);
    const error = await failure(sendSignedCompoundTransaction(wallet, transaction, summaryFor()));
    expect(String((error.cause as Error).message)).toContain("Third reward yield appeared");
    expect(error.sent).toBe(false);
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("zero-amount rewards do not block", async () => {
    vi.mocked(simulateAndVerifyCompound).mockResolvedValue({ rewards: [{ amount: "0" }] } as never);
    await expect(sendSignedCompoundTransaction(wallet, transaction, summaryFor())).resolves.toBeTruthy();
  });

  it("summary expiry passing during simulation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
    const summary = summaryFor({ expiresAt: Date.now() + 1_000 });
    vi.mocked(simulateAndVerifyCompound).mockImplementation(async () => { vi.setSystemTime(Date.now() + 2_000); return { rewards: [] } as never; });
    const error = await failure(sendSignedCompoundTransaction(wallet, transaction, summary));
    expect(error.cause).toEqual(new Error("Compound transaction expired before broadcast"));
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("chain passing lastValidBlockHeight during simulation", async () => {
    connection.getBlockHeight.mockResolvedValueOnce(100).mockResolvedValueOnce(151);
    const error = await failure(sendSignedCompoundTransaction(wallet, transaction, summaryFor()));
    expect(error.cause).toEqual(new Error("Compound transaction expired before broadcast"));
  });

  it("QUIRK: the payer check runs LAST (after state read + simulation + expiry), not first", async () => {
    const wrongPayerTx = buildTransaction({ payer: testKeypair(99) });
    const error = await failure(sendSignedCompoundTransaction(wallet, wrongPayerTx, summaryFor()));
    expect(error.cause).toEqual(new Error("Compound payer mismatch"));
    expect(simulateAndVerifyCompound).toHaveBeenCalledOnce();
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });
});

describe("sendSignedCompoundTransaction: broadcast failures", () => {
  it("signature mismatch: sent is unknown (no sent flag), message says to verify on-chain", async () => {
    connection.sendRawTransaction.mockResolvedValue("1".repeat(64));
    const error = await failure(sendSignedCompoundTransaction(wallet, transaction, summaryFor()));
    expect(error.cause).toEqual(new Error("RPC returned compound signature mismatch, please verify on-chain status"));
    expect(error.sent).toBeUndefined();
  });

  it.each<[string, string, boolean]>([
    ["preflight simulation failure", "Transaction simulation failed: custom program error: 0x1781", true],
    ["blockhash not found", "Blockhash not found", true],
    ["an unknown network error", "socket hang up", false],
    ["a Jupiter upstream message", "Jupiter HTTP 503", false],
  ])("sendRawTransaction rejecting with %s => sent:false is %s", async (_name, message, notSent) => {
    connection.sendRawTransaction.mockRejectedValue(new Error(message));
    const error = await failure(sendSignedCompoundTransaction(wallet, transaction, summaryFor()));
    expect(error.sent).toBe(notSent ? false : undefined);
    expect((error.cause as Error).message).toBe(message);
  });

  it("a Beam lookup failure after a successful send is reported as an error with unknown sent state", async () => {
    vi.mocked(lookupBeamAfterSend).mockRejectedValue(new Error("beam down"));
    const error = await failure(sendSignedCompoundTransaction(wallet, transaction, summaryFor()));
    expect(connection.sendRawTransaction).toHaveBeenCalledOnce();
    expect(error.sent).toBeUndefined();
  });
});

describe("reverifySignedCompound", () => {
  it("returns the connection it used so the caller broadcasts on the same one", async () => {
    await expect(reverifySignedCompound(wallet, transaction, summaryFor())).resolves.toBe(connection);
  });
});

// Characterization tests for lib/open-send.ts (broadcast path of open-position, shared by the web
// route and the MCP tool). Real: tx parsing, ed25519 signature verification, HMAC permit,
// CompoundSendError wrapping. Mocked: RPC, pool-state reader, simulation, Beam lookup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: vi.fn() }));
vi.mock("@sofinance/engine/open-state", () => ({ readOpenPoolState: vi.fn() }));
vi.mock("@sofinance/engine/open-simulation", () => ({ simulateAndVerifyOpenTransaction: vi.fn() }));
vi.mock("@/lib/beam-after-send", () => ({
  beamAfterSend: vi.fn(),
  noBeamAfterSend: (signature: string) => ({ beam: null, label: null, beamLandingUrl: `/api/beam-landing?signature=${signature}` }),
}));
const opensLog = vi.hoisted(() => ({ logPositionOpenBestEffort: vi.fn() }));
vi.mock("@/lib/opens-log", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/opens-log")>();
  return { ...original, logPositionOpenBestEffort: opensLog.logPositionOpenBestEffort };
});

import { SendTransactionError, VersionedTransaction } from "@solana/web3.js";
import { CompoundSendError } from "./public-error";
import { issueOpenPositionPermit } from "./open-permit";
import { readOpenPoolState } from "@sofinance/engine/open-state";
import { simulateAndVerifyOpenTransaction } from "@sofinance/engine/open-simulation";
import { rpcConnection } from "@sofinance/engine/rpc";
import { beamAfterSend } from "@/lib/beam-after-send";
import type { OpenPositionSummary } from "@sofinance/engine/open-types";
import { sendSignedOpenPosition, submitOpenPositionFromParts } from "./open-send";
import {
  BEAM_RESULT, BLOCKHASH, SIGNING_SECRET, buildTransaction, fakeConnection, type FakeConnection, messageBase64, openSummaryFixture, signatureOf,
  testKeypair, toBase64,
} from "./test-support/send-fixtures";

const walletKey = testKeypair(1);
const nftKey = testKeypair(2);
const wallet = walletKey.publicKey.toBase58();
const nftMint = nftKey.publicKey.toBase58();

const summaryFor = (overrides: Record<string, unknown> = {}) =>
  ({ ...openSummaryFixture({ wallet, nftMint, blockhash: BLOCKHASH }), ...overrides }) as unknown as OpenPositionSummary;

function poolState(overrides: Record<string, unknown> = {}) {
  const summary = summaryFor();
  return {
    paused: false, frozen: false, transferFee: false, unsupportedExtensions: [], sufficientSol: true,
    poolId: summary.poolId, inputMint: summary.inputMint, inputKind: summary.inputKind,
    balances: { ...summary.startingBalances }, ...overrides,
  };
}

const signed = () => buildTransaction({ payer: walletKey, extraSigners: [nftKey] });
let connection: FakeConnection;
let transaction: VersionedTransaction;

beforeEach(() => {
  vi.stubEnv("JUPITER_API_KEY", SIGNING_SECRET);
  transaction = signed();
  connection = fakeConnection({ sendRawTransaction: vi.fn(async () => signatureOf(transaction)) });
  vi.mocked(rpcConnection).mockReturnValue(connection as never);
  vi.mocked(readOpenPoolState).mockResolvedValue(poolState() as never);
  vi.mocked(simulateAndVerifyOpenTransaction).mockResolvedValue(undefined as never);
  vi.mocked(beamAfterSend).mockResolvedValue(BEAM_RESULT as never);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

async function failure(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(CompoundSendError);
  return error as CompoundSendError;
}

describe("sendSignedOpenPosition", () => {
  it("re-verifies, simulates with sigVerify, broadcasts with fixed options and returns beam + position ids", async () => {
    const summary = summaryFor();
    const result = await sendSignedOpenPosition(wallet, transaction, summary);
    expect(result).toEqual({
      signature: signatureOf(transaction), positionMint: nftMint, positionAccount: summary.positionAccount,
      beam: BEAM_RESULT.beam, beamLabel: "Beam landed", beamLandingUrl: BEAM_RESULT.beamLandingUrl,
    });
    expect(connection.sendRawTransaction).toHaveBeenCalledWith(expect.any(Uint8Array), {
      skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3,
    });
    expect(beamAfterSend).toHaveBeenCalledWith(signatureOf(transaction), summary.beam);
    expect(readOpenPoolState).toHaveBeenCalledWith(wallet, {
      poolId: summary.poolId, inputMint: summary.inputMint, inputKind: summary.inputKind,
    }, connection);
    expect(simulateAndVerifyOpenTransaction).toHaveBeenCalledWith(expect.objectContaining({
      connection, nftMint: expect.objectContaining({}), tickLower: -60, tickUpper: 60, requested: 2_000_000n,
      expectedLiquidity: 777n, maxSolDebitLamports: 9_000_000n, sigVerify: true,
    }));
    expect(vi.mocked(simulateAndVerifyOpenTransaction).mock.invocationCallOrder[0]!)
      .toBeLessThan(connection.sendRawTransaction.mock.invocationCallOrder[0]!);
    expect(opensLog.logPositionOpenBestEffort).toHaveBeenCalledOnce();
  });

  const authorization = "Open-position authorization type, wallet, or expiry mismatch";
  it.each<[string, Record<string, unknown>]>([
    ["operation is not open-position", { operation: "compound" }],
    ["expiresAt in the past", { expiresAt: Date.now() - 1 }],
    ["expiresAt not an integer", { expiresAt: Date.now() + 1000.5 }],
    ["lastValidBlockHeight not positive", { lastValidBlockHeight: 0 }],
    ["summary blockhash differs from the transaction's", { blockhash: "11111111111111111111111111111111" }],
    ["summary wallet differs", { wallet: testKeypair(77).publicKey.toBase58() }],
    ["quote wallet differs", { quote: { ...summaryFor().quote, wallet: testKeypair(77).publicKey.toBase58() } }],
  ])("rejects when %s (claims nothing was sent)", async (_name, override) => {
    const error = await failure(sendSignedOpenPosition(wallet, transaction, summaryFor(override)));
    expect(error.cause).toEqual(new Error(authorization));
    expect(error.sent).toBe(false);
    expect(rpcConnection).not.toHaveBeenCalled();
  });

  const structural = "Open-position payer, NFT mint signature, or transaction size mismatch";
  it.each<[string, () => VersionedTransaction, Record<string, unknown>]>([
    ["tx has a single signer", () => buildTransaction({ payer: walletKey }), {}],
    ["wallet signature is missing", () => buildTransaction({ payer: walletKey, extraSigners: [nftKey], signWith: [nftKey] }), {}],
    ["NFT mint signature is missing", () => buildTransaction({ payer: walletKey, extraSigners: [nftKey], signWith: [walletKey] }), {}],
    ["summary NFT mint is not the second account", signed, { nftMint: testKeypair(78).publicKey.toBase58() }],
  ])("rejects structurally when %s", async (_name, build, summaryOverride) => {
    const tx = build();
    const summary = summaryFor({ blockhash: tx.message.recentBlockhash, ...summaryOverride });
    const error = await failure(sendSignedOpenPosition(wallet, tx, summary));
    expect(error.cause).toEqual(new Error(structural));
    expect(error.sent).toBe(false);
  });

  it("verifies the NFT-mint signature before the wallet signature", async () => {
    const tx = signed();
    tx.signatures[1] = new Uint8Array(64).fill(5);
    expect((await failure(sendSignedOpenPosition(wallet, tx, summaryFor()))).cause).toEqual(new Error("Position NFT mint partial signature is invalid"));
    const tx2 = signed();
    tx2.signatures[0] = new Uint8Array(64).fill(5);
    expect((await failure(sendSignedOpenPosition(wallet, tx2, summaryFor()))).cause).toEqual(new Error("Wallet signature is invalid"));
    expect(rpcConnection).not.toHaveBeenCalled();
  });

  it("rejects when the chain has moved past lastValidBlockHeight", async () => {
    connection.getBlockHeight.mockResolvedValue(151);
    const error = await failure(sendSignedOpenPosition(wallet, transaction, summaryFor()));
    expect(error.cause).toEqual(new Error("Transaction blockhash expired"));
    expect(simulateAndVerifyOpenTransaction).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>]>([
    ["pool paused", { paused: true }],
    ["token frozen", { frozen: true }],
    ["transfer fee", { transferFee: true }],
    ["unsupported extensions", { unsupportedExtensions: ["TransferHook"] }],
    ["insufficient SOL", { sufficientSol: false }],
    ["pool id differs", { poolId: testKeypair(79).publicKey.toBase58() }],
    ["input mint differs", { inputMint: testKeypair(79).publicKey.toBase58() }],
    ["input kind differs", { inputKind: "token" }],
    ["input balance differs", { balances: { input: "1", a: "10", b: "20" } }],
    ["token A balance differs", { balances: { input: "5000000000", a: "11", b: "20" } }],
    ["token B balance differs", { balances: { input: "5000000000", a: "10", b: "21" } }],
  ])("rejects when state changed: %s", async (_name, stateOverride) => {
    vi.mocked(readOpenPoolState).mockResolvedValue(poolState(stateOverride) as never);
    const error = await failure(sendSignedOpenPosition(wallet, transaction, summaryFor()));
    expect(error.cause).toEqual(new Error("Pool, wallet balance, or asset flags have changed since preparation"));
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("QUIRK: it does not check position-NFT ownership/liquidity (open state has no such fields), only pool + balances", async () => {
    vi.mocked(readOpenPoolState).mockResolvedValue(poolState({ ownsNft: false, liquidity: "999" }) as never);
    await expect(sendSignedOpenPosition(wallet, transaction, summaryFor())).resolves.toMatchObject({ signature: signatureOf(transaction) });
  });

  it("propagates simulation failure and never broadcasts", async () => {
    vi.mocked(simulateAndVerifyOpenTransaction).mockRejectedValue(new Error("Open-position simulation failed: {}"));
    const error = await failure(sendSignedOpenPosition(wallet, transaction, summaryFor()));
    expect(error.message).toContain("simulation failed");
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("rejects when the summary expiry passes during simulation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
    const summary = summaryFor({ expiresAt: Date.now() + 1_000 });
    vi.mocked(simulateAndVerifyOpenTransaction).mockImplementation((async () => { vi.setSystemTime(Date.now() + 2_000); }) as never);
    const error = await failure(sendSignedOpenPosition(wallet, transaction, summary));
    expect(error.cause).toEqual(new Error("Signed transaction expired before broadcast"));
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("rejects when the blockhash window closes during simulation", async () => {
    connection.getBlockHeight.mockResolvedValueOnce(100).mockResolvedValueOnce(151);
    const error = await failure(sendSignedOpenPosition(wallet, transaction, summaryFor()));
    expect(error.cause).toEqual(new Error("Signed transaction expired before broadcast"));
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("keeps signature mismatch and network failures unknown after submission", async () => {
    connection.sendRawTransaction.mockResolvedValue("1".repeat(64));
    const mismatch = await failure(sendSignedOpenPosition(wallet, transaction, summaryFor()));
    expect(connection.sendRawTransaction).toHaveBeenCalledOnce();
    expect(mismatch.cause).toEqual(new Error("RPC returned transaction signature mismatch"));
    expect(mismatch.sent).toBeUndefined();

    connection.sendRawTransaction.mockRejectedValue(new Error("socket hang up"));
    const network = await failure(sendSignedOpenPosition(wallet, transaction, summaryFor()));
    expect(network.sent).toBeUndefined();
  });
  it("does not let optional Beam lookup failure overturn submission", async () => {
    connection.sendRawTransaction.mockResolvedValue(signatureOf(transaction));
    vi.mocked(beamAfterSend).mockRejectedValue(new Error("beam down"));
    await expect(sendSignedOpenPosition(wallet, transaction, summaryFor())).resolves.toMatchObject({
      signature: signatureOf(transaction), beam: null, beamLandingUrl: `/api/beam-landing?signature=${signatureOf(transaction)}`,
    });
  });
  it("marks only explicit RPC simulation rejection as unsent, not other RPC failures", async () => {
    connection.sendRawTransaction.mockRejectedValue(new SendTransactionError({ action: "simulate", signature: "",
      transactionMessage: "Transaction simulation failed: Error processing Instruction 0" }));
    expect((await failure(sendSignedOpenPosition(wallet, transaction, summaryFor()))).sent).toBe(false);
    connection.sendRawTransaction.mockRejectedValue(new SendTransactionError({ action: "simulate", signature: "",
      transactionMessage: "Too many requests (429)" }));
    expect((await failure(sendSignedOpenPosition(wallet, transaction, summaryFor()))).sent).toBeUndefined();
  });
});

describe("submitOpenPositionFromParts", () => {
  function parts(tx = transaction, summary = summaryFor(), secret = SIGNING_SECRET) {
    return {
      signedTransaction: toBase64(tx), wallet, summary,
      permit: issueOpenPositionPermit(secret, { wallet, summary, message: messageBase64(tx) }),
    };
  }

  it("verifies the permit then sends", async () => {
    await expect(submitOpenPositionFromParts(parts())).resolves.toMatchObject({ signature: signatureOf(transaction), positionMint: nftMint });
  });

  it("rejects a permit for a different summary (changed after issuing)", async () => {
    const input = parts();
    const tampered = { ...input, summary: { ...input.summary, tickUpper: 120 } as OpenPositionSummary };
    await expect(submitOpenPositionFromParts(tampered)).rejects.toThrow("Transaction does not match simulated open-position authorization");
    expect(rpcConnection).not.toHaveBeenCalled();
  });

  it("rejects a permit made with a different secret and a malformed permit", async () => {
    await expect(submitOpenPositionFromParts(parts(transaction, summaryFor(), "other-secret"))).rejects.toThrow("does not match simulated open-position");
    await expect(submitOpenPositionFromParts({ ...parts(), permit: "nothex" })).rejects.toThrow("does not match simulated open-position");
  });

  it("QUIRK: the permit check throws a plain Error (not CompoundSendError), so callers get no sent:false from the lib", async () => {
    const error = await submitOpenPositionFromParts({ ...parts(), permit: "nothex" }).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(CompoundSendError);
  });

  it("QUIRK: with no JUPITER_API_KEY the permit helper throws 'Missing server signing key' (the key doubles as the HMAC secret)", async () => {
    const input = parts();
    vi.stubEnv("JUPITER_API_KEY", undefined);
    await expect(submitOpenPositionFromParts(input)).rejects.toThrow("Missing server signing key");
  });

  it("surfaces a raw deserialize error for a garbage transaction", async () => {
    await expect(submitOpenPositionFromParts({ ...parts(), signedTransaction: "AAAA" })).rejects.toThrow();
  });
});

describe("sendSignedOpenPosition: Beam landing never blocks the broadcast response", () => {
  it("with no tip, the real helper makes no Beam request; with a hanging Beam API and a tip, it returns within the cap", async () => {
    const real = await vi.importActual<typeof import("@/lib/beam-after-send")>("@/lib/beam-after-send");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    try {
      vi.mocked(beamAfterSend).mockImplementation(real.beamAfterSend);
      const untipped = summaryFor();
      untipped.beam = { included: false, tipLamports: 0, tipAddress: null, skippedReason: "no-tip-address" };
      await expect(sendSignedOpenPosition(wallet, transaction, untipped)).resolves.toMatchObject({ beam: null, beamLabel: null });
      expect(fetchSpy).not.toHaveBeenCalled();

      const tipped = summaryFor();
      tipped.beam = { included: true, tipLamports: 100_000, tipAddress: "tip", skippedReason: null };
      const started = Date.now();
      await expect(sendSignedOpenPosition(wallet, transaction, tipped)).resolves.toMatchObject({ beam: null, beamLabel: null });
      expect(Date.now() - started).toBeLessThan(real.BEAM_INLINE_LOOKUP_TIMEOUT_MS + 1_000);
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// Real route parsing, permits, signature checks and engine retry wrapper; no RPC traffic.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey, SendTransactionError, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createCloseAccountInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: vi.fn() }));
vi.mock("@sofinance/engine/compound-recovery", () => ({ simulateAndVerifyRecovery: vi.fn() }));
vi.mock("@/lib/compound-cleanup-batch", async original => ({
  ...await original<typeof import("@/lib/compound-cleanup-batch")>(), simulateAndVerifyCleanupBatch: vi.fn(),
}));

import { rpcConnection } from "@sofinance/engine/rpc";
import { createResilientConnection } from "@sofinance/engine/rpc/connection";
import { simulateAndVerifyRecovery } from "@sofinance/engine/compound-recovery";
import type { CompoundRecoverySummary } from "@sofinance/engine/compound-recovery-types";
import { issueCompoundPermit } from "./compound-permit";
import { issueCleanupBatchPermit, simulateAndVerifyCleanupBatch } from "./compound-cleanup-batch";
import { resolveCompoundBroadcastFailure } from "./public-error";
import { POST as recover } from "@/app/api/compound-recover-broadcast/route";
import { POST as cleanup } from "@/app/api/compound-cleanup-broadcast/route";
import {
  BLOCKHASH, SIGNING_SECRET, fakeConnection, jsonRequest, messageBase64, signatureOf, testKeypair, toBase64,
} from "./test-support/send-fixtures";

beforeEach(() => {
  vi.stubEnv("JUPITER_API_KEY", SIGNING_SECRET);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(simulateAndVerifyRecovery).mockResolvedValue(undefined as never);
  vi.mocked(simulateAndVerifyCleanupBatch).mockResolvedValue({ unitsConsumed: 1 });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

async function fixture(issuePermit: typeof issueCompoundPermit) {
  const signer = testKeypair(1), wallet = signer.publicKey.toBase58(), mint = testKeypair(2).publicKey;
  const seed = "send_safety", source = await PublicKey.createWithSeed(signer.publicKey, seed, TOKEN_PROGRAM_ID);
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: signer.publicKey, recentBlockhash: BLOCKHASH,
    instructions: [createCloseAccountInstruction(source, signer.publicKey, signer.publicKey)],
  }).compileToV0Message());
  transaction.sign([signer]);
  const summary: CompoundRecoverySummary = {
    operation: "recovery", simulated: true, wallet,
    compoundAccounts: [{ seed, address: source.toBase58(), mint: mint.toBase58(), program: TOKEN_PROGRAM_ID.toBase58(),
      space: 165, rentLamports: 2039280, sourceLamports: 2039280, amount: "0", decimals: 6,
      destination: getAssociatedTokenAddressSync(mint, signer.publicKey).toBase58() }],
    blockhash: BLOCKHASH, lastValidBlockHeight: 150, expiresAt: Date.now() + 60_000,
    sizeBytes: transaction.serialize().length, feeLamports: 5000,
  };
  const body = { wallet, summary, signedTransaction: toBase64(transaction),
    permit: issuePermit(SIGNING_SECRET, { wallet, summary, message: messageBase64(transaction) }) };
  const connection = fakeConnection();
  vi.mocked(rpcConnection).mockReturnValue(createResilientConnection(connection as never, null, {
    primaryId: "solami", fallbackId: "default",
    retry: { maxAttempts: 2, baseMs: 0, maxDelayMs: 0, budgetMs: 2000 },
  }));
  return { transaction, body, connection };
}

describe.each([
  { name: "recovery", submit: recover, issuePermit: issueCompoundPermit, simulate: simulateAndVerifyRecovery },
  { name: "cleanup", submit: cleanup, issuePermit: issueCleanupBatchPermit, simulate: simulateAndVerifyCleanupBatch },
])("$name send boundary", ({ name, submit, issuePermit, simulate }) => {
  it.each([false, true])("keeps preflight rejection pending (earlier timeout: %s)", async timeoutFirst => {
    const { connection, transaction, body } = await fixture(issuePermit);
    if (timeoutFirst) connection.sendRawTransaction.mockRejectedValueOnce(new Error("request timed out after remote acceptance"));
    connection.sendRawTransaction.mockRejectedValue(new SendTransactionError({ action: "simulate", signature: "",
      transactionMessage: "Transaction simulation failed: insufficient funds" }));
    const response = await submit(jsonRequest(`http://localhost/api/${name}`, body));
    const result = await response.json();
    expect(response.status).toBe(400);
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(timeoutFirst ? 2 : 1);
    for (const [bytes] of connection.sendRawTransaction.mock.calls) expect(bytes).toEqual(transaction.serialize());
    expect(result).not.toHaveProperty("sent");
    expect(resolveCompoundBroadcastFailure({ persisted: true, sent: result.sent, message: result.error }))
      .toEqual({ abandon: false, keepPending: true, error: "" });
  });

  it("still reports local simulation rejection as definitely unsent", async () => {
    const { connection, body } = await fixture(issuePermit);
    vi.mocked(simulate).mockRejectedValue(new Error("Transaction simulation failed: insufficient funds"));
    const response = await submit(jsonRequest(`http://localhost/api/${name}`, body));
    expect(await response.json()).toMatchObject({ sent: false });
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("keeps signature mismatch unknown after RPC acceptance", async () => {
    const { connection, transaction, body } = await fixture(issuePermit);
    connection.sendRawTransaction.mockResolvedValue(`${signatureOf(transaction)}wrong`);
    const response = await submit(jsonRequest(`http://localhost/api/${name}`, body));
    expect(await response.json()).not.toHaveProperty("sent");
    expect(connection.sendRawTransaction).toHaveBeenCalledOnce();
  });
});

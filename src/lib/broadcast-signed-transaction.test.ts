import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { ComputeBudgetProgram, Keypair, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import {
  BROADCAST_SEND_OPTIONS, BroadcastExpiredError, BroadcastSignatureMismatchError,
  broadcastSignedTransaction, isBroadcastExpiredError,
} from "./broadcast-signed-transaction";

function signedTx() {
  const signer = Keypair.generate();
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000 })],
  }).compileToV0Message());
  transaction.sign([signer]);
  return transaction;
}

function connection(overrides: { height?: number; send?: string } = {}) {
  return {
    getBlockHeight: vi.fn(async () => overrides.height ?? 10),
    sendRawTransaction: vi.fn<(raw: Uint8Array, options?: unknown) => Promise<string>>(async (raw) =>
      overrides.send ?? bs58.encode(VersionedTransaction.deserialize(raw).signatures[0]!)),
  };
}

describe("broadcastSignedTransaction", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("sends once with the shared preflight options and returns the first signature", async () => {
    const transaction = signedTx();
    const conn = connection();
    const signature = await broadcastSignedTransaction({ connection: conn, transaction });
    expect(signature).toBe(bs58.encode(transaction.signatures[0]!));
    expect(conn.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(conn.sendRawTransaction.mock.calls[0]![1]).toEqual(BROADCAST_SEND_OPTIONS);
    expect(BROADCAST_SEND_OPTIONS).toEqual({ skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
    expect(conn.getBlockHeight).not.toHaveBeenCalled();
  });

  it("refuses an expired clock or a block height past lastValid before sending", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T08:00:00Z"));
    const transaction = signedTx();
    const timed = connection({ height: 10 });
    await expect(broadcastSignedTransaction({
      connection: timed, transaction,
      expiry: { lastValidBlockHeight: 100, expiresAt: Date.now() },
      expiredMessage: "Signed transaction expired before broadcast",
    })).rejects.toBeInstanceOf(BroadcastExpiredError);
    await expect(broadcastSignedTransaction({
      connection: timed, transaction,
      expiry: { lastValidBlockHeight: 100, expiresAt: Date.now() },
    })).rejects.toThrow("Signed transaction expired before broadcast");
    expect(timed.sendRawTransaction).not.toHaveBeenCalled();
    expect(isBroadcastExpiredError(new BroadcastExpiredError("x"))).toBe(true);

    const height = connection({ height: 101 });
    await expect(broadcastSignedTransaction({
      connection: height, transaction,
      expiry: { lastValidBlockHeight: 100 },
      expiredMessage: "Cleanup transaction expired before broadcast",
    })).rejects.toMatchObject({ message: "Cleanup transaction expired before broadcast", code: "broadcast_expired" });
    expect(height.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("does not treat a missing expiresAt as expired when the blockhash is still valid", async () => {
    const transaction = signedTx();
    const conn = connection({ height: 100 });
    await expect(broadcastSignedTransaction({
      connection: conn, transaction, expiry: { lastValidBlockHeight: 100 },
    })).resolves.toBe(bs58.encode(transaction.signatures[0]!));
  });

  it("rejects a different RPC signature after send, with the caller's message", async () => {
    const transaction = signedTx();
    const conn = connection({ send: bs58.encode(new Uint8Array(64).fill(8)) });
    const onBeforeSend = vi.fn();
    await expect(broadcastSignedTransaction({
      connection: conn, transaction, onBeforeSend,
      mismatchMessage: "RPC returned a different signature",
    })).rejects.toBeInstanceOf(BroadcastSignatureMismatchError);
    await expect(broadcastSignedTransaction({
      connection: conn, transaction,
      mismatchMessage: "RPC returned a different signature",
    })).rejects.toThrow("RPC returned a different signature");
    expect(onBeforeSend).toHaveBeenCalledTimes(1);
    expect(conn.sendRawTransaction).toHaveBeenCalled();
  });

  it("uses an explicit expectedSignature and runs onBeforeSend only after the expiry check passes", async () => {
    const transaction = signedTx();
    const expected = "explicit-signature";
    const conn = connection({ height: 101, send: expected });
    const onBeforeSend = vi.fn();
    await expect(broadcastSignedTransaction({
      connection: conn, transaction, expectedSignature: expected,
      expiry: { lastValidBlockHeight: 100 },
      onBeforeSend,
    })).rejects.toBeInstanceOf(BroadcastExpiredError);
    expect(onBeforeSend).not.toHaveBeenCalled();

    const ok = connection({ height: 99, send: expected });
    const started = vi.fn();
    await expect(broadcastSignedTransaction({
      connection: ok, transaction, expectedSignature: expected,
      expiry: { lastValidBlockHeight: 100 },
      onBeforeSend: started,
    })).resolves.toBe(expected);
    expect(started).toHaveBeenCalledTimes(1);
  });
});

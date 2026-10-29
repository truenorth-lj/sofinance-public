import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const POOL = "53oyyjgybx6dH7i5aGeKfBUi3xPJQDeBkaENPri57x2H";
const BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";
const FEE_WALLET = Keypair.generate().publicKey;
const feeConfig = () => ({ wallet: FEE_WALLET, bps: 10 });

const wallet = Keypair.generate();
const position = Keypair.generate();

function build(instructions: TransactionInstruction[]) {
  const message = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: BLOCKHASH, instructions }).compileToV0Message();
  return new VersionedTransaction(message);
}
const initIx = () => new TransactionInstruction({
  programId: PROGRAM,
  keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: true }, { pubkey: position.publicKey, isSigner: true, isWritable: true }],
  data: Buffer.from([1, 2, 3]),
});
const b64 = (tx: VersionedTransaction) => Buffer.from(tx.serialize()).toString("base64");

function connection(overrides: Record<string, unknown> = {}) {
  return {
    getAddressLookupTable: vi.fn(),
    getBlockHeight: vi.fn(async () => 100),
    getBalance: vi.fn(async () => 1_000_000_000),
    simulateTransaction: vi.fn(async () => ({ value: { err: null, accounts: [{ lamports: 1_000_000_000 - 50_000 }] } })),
    sendRawTransaction: vi.fn(async (raw: Uint8Array) => bs58.encode(VersionedTransaction.deserialize(raw).signatures[0]!)),
    ...overrides,
  };
}

async function load() {
  return import("./meteora-open-send");
}

async function prepared(instructions = [initIx()], kind: "setup" | "deposit" | "close" = "setup") {
  const { issueMeteoraTxPermit } = await load();
  const tx = build(instructions);
  const summary = {
    kind, wallet: wallet.publicKey.toBase58(), poolId: POOL, position: position.publicKey.toBase58(), blockhash: BLOCKHASH,
    lastValidBlockHeight: 200, expiresAt: Date.now() + 60_000, maxSolDebitLamports: "1000000",
  };
  return { unsignedTransaction: b64(tx), summary, permit: issueMeteoraTxPermit(b64(tx), summary), tx };
}

function signBoth(tx: VersionedTransaction) {
  const copy = VersionedTransaction.deserialize(tx.serialize());
  copy.sign([wallet]);
  copy.sign([position]);
  return copy;
}

beforeEach(() => { vi.stubEnv("JUPITER_API_KEY", "test-permit-secret"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("sendMeteoraTransaction", () => {
  it("broadcasts a correctly signed 1/2 and returns its signature", async () => {
    const { sendMeteoraTransaction } = await load();
    const p = await prepared();
    const conn = connection();
    const signed = signBoth(p.tx);
    const result = await sendMeteoraTransaction({ ...p, signedTransaction: b64(signed) }, { connection: conn as never, feeConfig });
    expect(result.signature).toBe(bs58.encode(signed.signatures[0]!));
    expect(conn.simulateTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sigVerify: true }));
  });

  it("rejects a tampered summary (permit mismatch) without sending", async () => {
    const { sendMeteoraTransaction, MeteoraSendError } = await load();
    const p = await prepared();
    const conn = connection();
    const call = sendMeteoraTransaction({ ...p, summary: { ...p.summary, maxSolDebitLamports: "999999999" }, signedTransaction: b64(signBoth(p.tx)) }, { connection: conn as never, feeConfig });
    await expect(call).rejects.toBeInstanceOf(MeteoraSendError);
    await expect(call).rejects.toMatchObject({ sent: false });
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("rejects a wallet-returned tx with an extra instruction", async () => {
    const { sendMeteoraTransaction } = await load();
    const p = await prepared();
    const extra = new TransactionInstruction({ programId: PROGRAM, keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: true }, { pubkey: position.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([9]) });
    const changed = signBoth(build([initIx(), extra]));
    const conn = connection();
    await expect(sendMeteoraTransaction({ ...p, signedTransaction: b64(changed) }, { connection: conn as never, feeConfig })).rejects.toMatchObject({ sent: false });
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("rejects any instruction touching the fee wallet (#219 guard) and bare SystemProgram.transfer", async () => {
    const { sendMeteoraTransaction } = await load();
    const usdc = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    const feeIx = createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, getAssociatedTokenAddressSync(usdc, FEE_WALLET), FEE_WALLET, usdc);
    const transferIx = SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 });
    for (const ixs of [[initIx(), feeIx], [initIx(), transferIx]]) {
      const p = await prepared(ixs);
      const conn = connection();
      await expect(sendMeteoraTransaction({ ...p, signedTransaction: b64(signBoth(p.tx)) }, { connection: conn as never, feeConfig })).rejects.toMatchObject({ sent: false });
      expect(conn.sendRawTransaction).not.toHaveBeenCalled();
    }
  });

  it("rejects a missing position signature and an unexpected signer set", async () => {
    const { sendMeteoraTransaction } = await load();
    const p = await prepared();
    const onlyWallet = VersionedTransaction.deserialize(p.tx.serialize());
    onlyWallet.sign([wallet]);
    await expect(sendMeteoraTransaction({ ...p, signedTransaction: b64(onlyWallet) }, { connection: connection() as never, feeConfig })).rejects.toThrow(/Position signature/);
    const asDeposit = await prepared([initIx()], "deposit");
    await expect(sendMeteoraTransaction({ ...asDeposit, signedTransaction: b64(signBoth(asDeposit.tx)) }, { connection: connection() as never, feeConfig })).rejects.toThrow(/Unexpected signers/);
  });

  it("rejects expired permits and SOL debit above the cap", async () => {
    const { sendMeteoraTransaction } = await load();
    const p = await prepared();
    const signed = b64(signBoth(p.tx));
    await expect(sendMeteoraTransaction({ ...p, signedTransaction: signed }, { connection: connection() as never, feeConfig, now: () => p.summary.expiresAt + 1 })).rejects.toThrow(/expired/);
    await expect(sendMeteoraTransaction({ ...p, signedTransaction: signed }, { connection: connection({ getBlockHeight: vi.fn(async () => 201) }) as never, feeConfig })).rejects.toThrow(/expired/);
    const greedy = connection({ simulateTransaction: vi.fn(async () => ({ value: { err: null, accounts: [{ lamports: 0 }] } })) });
    await expect(sendMeteoraTransaction({ ...p, signedTransaction: signed }, { connection: greedy as never, feeConfig })).rejects.toThrow(/more SOL than estimated/);
    expect(greedy.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("reports sent=true with the expected signature when the RPC send errors", async () => {
    const { sendMeteoraTransaction } = await load();
    const p = await prepared();
    const signed = signBoth(p.tx);
    const conn = connection({ sendRawTransaction: vi.fn(async () => { throw new Error("timeout"); }) });
    await expect(sendMeteoraTransaction({ ...p, signedTransaction: b64(signed) }, { connection: conn as never, feeConfig })).rejects.toMatchObject({ sent: true, signature: bs58.encode(signed.signatures[0]!) });
  });
});

describe("meteoraTransactionStatus", () => {
  const sig = "5".repeat(88);
  it("maps confirmed, failed, expired and pending", async () => {
    const { meteoraTransactionStatus } = await load();
    const conn = (value: unknown, height = 100) => ({ getSignatureStatuses: vi.fn(async () => ({ value: [value] })), getBlockHeight: vi.fn(async () => height) });
    expect((await meteoraTransactionStatus({ signature: sig, lastValidBlockHeight: 150 }, conn({ err: null, confirmationStatus: "confirmed" }) as never)).status).toBe("confirmed");
    expect((await meteoraTransactionStatus({ signature: sig, lastValidBlockHeight: 150 }, conn({ err: { InstructionError: [1, "Custom"] }, confirmationStatus: "confirmed" }) as never)).status).toBe("failed");
    expect((await meteoraTransactionStatus({ signature: sig, lastValidBlockHeight: 150 }, conn(null, 151) as never)).status).toBe("expired");
    expect((await meteoraTransactionStatus({ signature: sig, lastValidBlockHeight: 150 }, conn(null, 100) as never)).status).toBe("pending");
    expect((await meteoraTransactionStatus({ signature: sig, lastValidBlockHeight: 150 }, conn({ err: null, confirmationStatus: "processed" }) as never)).status).toBe("pending");
  });
});

import { afterEach, expect, it, vi } from "vitest";
import { PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { createEphemeralMint } from "./ephemeral-mint";
import { addMintSignature, assertWalletReturnedTransaction } from "./open-signatures";
import { phantomRewriteTransaction, testKeypair, BLOCKHASH } from "./test-support/send-fixtures";

afterEach(() => vi.restoreAllMocks());

it("signs the wallet-returned Phantom message with the exact owned buffer, then clears it idempotently", () => {
  const keyPair = nacl.sign.keyPair;
  let generated!: ReturnType<typeof keyPair>;
  vi.spyOn(nacl.sign, "keyPair").mockImplementation(() => { generated = keyPair(); return generated; });
  const mint = createEphemeralMint();
  try {
    const secret = mint.secretKey;
    expect(secret === generated.secretKey).toBe(true);
    expect(secret.some(byte => byte !== 0)).toBe(true);
    const payer = testKeypair(1);
    const prepared = new VersionedTransaction(new TransactionMessage({
      payerKey: payer.publicKey, recentBlockhash: BLOCKHASH,
      instructions: [new TransactionInstruction({ programId: SystemProgram.programId, data: Buffer.alloc(0),
        keys: [{ pubkey: mint.publicKey, isSigner: true, isWritable: true }] })],
    }).compileToV0Message());
    const walletReturned = phantomRewriteTransaction(prepared);
    walletReturned.sign([payer]);
    const walletSignature = Uint8Array.from(walletReturned.signatures[0]!);
    assertWalletReturnedTransaction(prepared, walletReturned, payer.publicKey.toBase58());
    const signed = addMintSignature(walletReturned, mint);
    expect(signed.signatures[0]).toEqual(walletSignature);
    for (let i = 0; i < 2; i++) expect(nacl.sign.detached.verify(signed.message.serialize(), signed.signatures[i]!, signed.message.staticAccountKeys[i]!.toBytes())).toBe(true);
    mint.dispose(); mint.dispose();
    expect(mint.secretKey === secret).toBe(true);
    expect(secret.every(byte => byte === 0)).toBe(true);
    // Disposal does not change the already signed message or signatures.
    const serialized = VersionedTransaction.deserialize(signed.serialize());
    expect(nacl.sign.detached.verify(serialized.message.serialize(), serialized.signatures[1]!, mint.publicKey.toBytes())).toBe(true);
    expect(nacl.sign.keyPair).toHaveBeenCalledOnce();
  } finally { mint.dispose(); }
});

it("allocates distinct mint identities and independent buffers", () => {
  const first = createEphemeralMint(), second = createEphemeralMint();
  try {
    expect(first.publicKey.equals(second.publicKey)).toBe(false);
    expect(first.secretKey === second.secretKey).toBe(false);
    first.dispose();
    expect(first.secretKey.every(byte => byte === 0)).toBe(true);
    expect(second.secretKey.some(byte => byte !== 0)).toBe(true);
  } finally { first.dispose(); second.dispose(); }
});

it("clears the generated owned buffer if public-key initialization fails", () => {
  const generated = nacl.sign.keyPair();
  // Invalid length forces the real PublicKey constructor to reject, without mocking web3.
  vi.spyOn(nacl.sign, "keyPair").mockReturnValue({ publicKey: new Uint8Array(33).fill(1), secretKey: generated.secretKey });
  expect(() => new PublicKey(new Uint8Array(33).fill(1))).toThrow();
  expect(() => createEphemeralMint()).toThrow();
  expect(generated.secretKey.every(byte => byte === 0)).toBe(true);
});

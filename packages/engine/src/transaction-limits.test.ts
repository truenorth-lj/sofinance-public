import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, SystemProgram } from "@solana/web3.js";
import { ATOMIC_COMPUTE_UNIT_LIMIT, SOLANA_TX_SIZE_LIMIT, atomicComputeUnitLimitInstruction, exceedsTxSizeLimit, isSingleWalletSignedTransaction, isZeroSignature } from "./transaction-limits";
import { MAX_OPEN_TRANSACTION_BYTES } from "./open-transaction";
import { BEAM_TX_SIZE_LIMIT } from "./solami-beam";

const tx = (payer: Keypair, sign = true) => {
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: PublicKey.default.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: PublicKey.default, lamports: 1 })] }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  if (sign) transaction.sign([payer]);
  return transaction;
};

describe("transaction limits", () => {
  it("keeps one packet limit everywhere", () => {
    expect(SOLANA_TX_SIZE_LIMIT).toBe(1232);
    expect(MAX_OPEN_TRANSACTION_BYTES).toBe(SOLANA_TX_SIZE_LIMIT);
    expect(BEAM_TX_SIZE_LIMIT).toBe(SOLANA_TX_SIZE_LIMIT);
    expect(exceedsTxSizeLimit(1232)).toBe(false);
    expect(exceedsTxSizeLimit(1233)).toBe(true);
  });
  it("builds the shared compute-unit instruction", () => {
    expect(atomicComputeUnitLimitInstruction().data.readUInt32LE(1)).toBe(ATOMIC_COMPUTE_UNIT_LIMIT);
  });
  it("validates single wallet-signed transactions", () => {
    const payer = Keypair.generate();
    expect(isZeroSignature(undefined)).toBe(true);
    expect(isSingleWalletSignedTransaction(tx(payer), payer.publicKey.toBase58())).toBe(true);
    expect(isSingleWalletSignedTransaction(tx(payer, false), payer.publicKey.toBase58())).toBe(false);
    expect(isSingleWalletSignedTransaction(tx(payer), Keypair.generate().publicKey.toBase58())).toBe(false);
  });
});

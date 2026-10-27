import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { InstructionGroupTooLargeError, packInstructionGroups, planFromSingleResult, planFromWithdrawResult, requiredSigners } from "./plan";
import { versionedTransactionSize } from "./open-transaction";

const blockhash = "11111111111111111111111111111111";
const key = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey;
const memo = (bytes: number, signer?: PublicKey) => new TransactionInstruction({ programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
  keys: signer ? [{ pubkey: signer, isSigner: true, isWritable: false }] : [], data: Buffer.alloc(bytes, 1) });

describe("transaction plans", () => {
  it("lists required signers fee payer first", () => {
    const sponsor = key(1), wallet = key(2);
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: sponsor, recentBlockhash: blockhash, instructions: [memo(4, wallet)] }).compileToV0Message());
    expect(requiredSigners(tx)).toEqual([sponsor.toBase58(), wallet.toBase58()]);
    expect(planFromSingleResult("compound", { transaction: tx })).toMatchObject({ atomic: true, steps: [{ label: "compound", signers: [sponsor.toBase58(), wallet.toBase58()] }] });
  });
  it("packs ordered groups into as few packets as fit and never splits a group", () => {
    const payer = key(1), wallet = key(2);
    const groups = [[memo(300, wallet)], [memo(300, wallet), memo(50)], [memo(800)]];
    const plan = packInstructionGroups({ payerKey: payer, recentBlockhash: blockhash, groups, labels: index => ["swap", "open"][index] ?? "extra" });
    expect(plan.atomic).toBe(false);
    expect(plan.steps.map(step => step.label)).toEqual(["swap", "open"]);
    expect(plan.steps.map(step => step.transaction.message.compiledInstructions.length)).toEqual([3, 1]);
    for (const step of plan.steps) {
      expect(step.sizeBytes).toBe(versionedTransactionSize(step.transaction));
      expect(step.sizeBytes).toBeLessThanOrEqual(1232);
      expect(step.signers[0]).toBe(payer.toBase58());
    }
  });
  it("returns one atomic step when everything fits", () => {
    const plan = packInstructionGroups({ payerKey: key(1), recentBlockhash: blockhash, groups: [[memo(10)], [SystemProgram.transfer({ fromPubkey: key(2), toPubkey: key(1), lamports: 1 })]] });
    expect(plan.atomic).toBe(true);
    expect(plan.steps).toHaveLength(1);
  });
  it("throws a typed error for a group that can never fit", () => {
    expect(() => packInstructionGroups({ payerKey: key(1), recentBlockhash: blockhash, groups: [[memo(10)], [memo(1300)]] })).toThrow(InstructionGroupTooLargeError);
  });
  it("adapts a two-stage withdraw result", () => {
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: key(2), recentBlockhash: blockhash, instructions: [memo(4)] }).compileToV0Message());
    const unsignedTransaction = Buffer.from(tx.serialize()).toString("base64");
    expect(planFromWithdrawResult({ unsignedTransaction, summary: { stage: "withdraw", transactions: 2 } })).toMatchObject({ atomic: false, followUpStage: "swap", steps: [{ label: "withdraw" }] });
    expect(planFromWithdrawResult({ unsignedTransaction, summary: { stage: "atomic", transactions: 1 } })).toMatchObject({ atomic: true, followUpStage: null });
  });
});

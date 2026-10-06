import "server-only";

import { createHash } from "node:crypto";
import bs58 from "bs58";
import { createCloseAccountInstruction, createTransferCheckedInstruction } from "@solana/spl-token";
import { PublicKey, type Connection, type PartiallyDecodedInstruction, type TransactionInstruction } from "@solana/web3.js";
import type { CompoundAccount, CompoundPositionState, CompoundPriorSource } from "./compound-types";
import { importVerifiedCompoundReceipt } from "./compound-recovery-import";
import { readRecoveryAccounts } from "./compound-recovery";

const discriminator = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

/** Only finalized, chain-proven leftover yield may fund the next fresh attempt. */
export async function readCompoundPriorSources(
  connection: Connection,
  state: CompoundPositionState,
  accounts: [CompoundAccount, CompoundAccount],
  sourceSignatures: unknown = [],
): Promise<{ sources: CompoundPriorSource[]; instructions: TransactionInstruction[] }> {
  if (!Array.isArray(sourceSignatures) || sourceSignatures.length > 3 ||
    sourceSignatures.some((signature) => typeof signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature))) {
    throw new Error("Maximum three finalized compound yield transactions may be imported per attempt");
  }
  const wallet = new PublicKey(state.wallet);
  const sources: CompoundPriorSource[] = [];
  const instructions: TransactionInstruction[] = [];
  const seen = new Set<string>();
  for (const signature of new Set(sourceSignatures as string[])) {
    if (bs58.decode(signature).length !== 64) throw new Error("Invalid original compound transaction signature");
    const transaction = await connection.getParsedTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    if (!transaction || transaction.transaction.signatures[0] !== signature) throw new Error("Unable to confirm original compound transaction completion");
    const receipt = await importVerifiedCompoundReceipt(connection, transaction, state.wallet, signature);
    if (receipt.positionMint !== state.positionMint) throw new Error("Original yield does not belong to current NFT position");
    const protocol = transaction.transaction.message.instructions.filter((instruction): instruction is PartiallyDecodedInstruction =>
      instruction.programId.toBase58() === state.programId && "accounts" in instruction);
    const harvest = protocol.find((instruction) => Buffer.from(bs58.decode(instruction.data)).subarray(0, 8).equals(discriminator("decrease_liquidity_v2")));
    const add = protocol.find((instruction) => Buffer.from(bs58.decode(instruction.data)).subarray(0, 8).equals(discriminator("increase_liquidity_v2")));
    if (harvest?.accounts[3]?.toBase58() !== state.poolId || add?.accounts[2]?.toBase58() !== state.poolId ||
      harvest.accounts[2]?.toBase58() !== state.positionAccount || add.accounts[4]?.toBase58() !== state.positionAccount) {
      throw new Error("Original yield pool or position mismatch");
    }
    const current = await connection.getMultipleAccountsInfo(receipt.compoundAccounts.map((account) => new PublicKey(account.address)), "confirmed");
    const open = receipt.compoundAccounts.filter((_account, index) => current[index] !== null);
    if (!open.length) continue;
    const recovered = await readRecoveryAccounts(connection, state.wallet, open);
    for (const account of recovered) {
      if (seen.has(account.address)) throw new Error("Duplicate original yield source account");
      seen.add(account.address);
      const destination = accounts.find((candidate) => candidate.mint === account.mint && candidate.program === account.program);
      if (!destination || account.address === destination.address) throw new Error("Original yield mint, program, or destination account mismatch");
      const index = transaction.transaction.message.accountKeys.findIndex((key) => key.pubkey.toBase58() === account.address);
      const original = transaction.meta?.postTokenBalances?.find((balance) => balance.accountIndex === index);
      if (!original || original.owner !== state.wallet || original.mint !== account.mint || original.programId !== account.program ||
        original.uiTokenAmount.decimals !== account.decimals || !/^\d+$/.test(original.uiTokenAmount.amount)) {
        throw new Error("Original compound lacks verifiable yield balance evidence");
      }
      if (BigInt(account.amount) > BigInt(original.uiTokenAmount.amount)) throw new Error("Original yield account has additional deposits, cannot be used as compound yield");
      if (!Number.isSafeInteger(account.rentLamports) || account.rentLamports < 0) throw new Error("Invalid original yield account rent");
      const program = new PublicKey(account.program);
      const source = new PublicKey(account.address);
      if (BigInt(account.amount) > 0n) instructions.push(createTransferCheckedInstruction(source, new PublicKey(account.mint),
        new PublicKey(destination.address), wallet, BigInt(account.amount), account.decimals, [], program));
      instructions.push(createCloseAccountInstruction(source, wallet, wallet, [], program));
      sources.push({ sourceSignature: signature, address: account.address, mint: account.mint, program: account.program,
        amount: account.amount, destination: destination.address, refundLamports: account.rentLamports });
    }
  }
  return { sources, instructions };
}

import { CLMM_PROGRAM_ID } from "@raydium-io/raydium-sdk-v2";
import type { ParsedTransactionWithMeta, PartiallyDecodedInstruction } from "@solana/web3.js";

/** Preserve parent indexes for transfer proof inside a Jupiter invocation.
 * Direct historical Raydium swaps remain readable. */
export function compoundProtocolInstructions(transaction: ParsedTransactionWithMeta) {
  return transaction.transaction.message.instructions.flatMap((instruction, index) => {
    const inner = transaction.meta?.innerInstructions?.find(group => group.index === index)?.instructions ?? [];
    return [instruction, ...inner].flatMap(ix => ix.programId.equals(CLMM_PROGRAM_ID) && "accounts" in ix
      ? [{ instruction: ix as PartiallyDecodedInstruction, index }] : []);
  });
}

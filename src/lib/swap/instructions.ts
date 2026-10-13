import "server-only";

import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { ApiInstruction, BuildRoute } from "./jupiter";

export function instruction(value: ApiInstruction, wallet: PublicKey) {
  if (value.accounts.some((account) => account.isSigner && account.pubkey !== wallet.toBase58())) {
    throw new Error("Route contains non-wallet signer");
  }
  return new TransactionInstruction({
    programId: new PublicKey(value.programId),
    keys: value.accounts.map((account) => ({
      pubkey: new PublicKey(account.pubkey), isSigner: account.isSigner, isWritable: account.isWritable,
    })),
    data: Buffer.from(value.data, "base64"),
  });
}

/** Preserve Jupiter's setup → swap → cleanup → other order. Compute budget
 * and Beam tips remain the responsibility of each atomic flow. */
export function swapRouteInstructions(routes: Pick<BuildRoute, "setupInstructions" | "swapInstruction" | "cleanupInstruction" | "otherInstructions">[], wallet: PublicKey): TransactionInstruction[] {
  return routes.flatMap((route) => [
    ...route.setupInstructions.map((ix) => instruction(ix, wallet)),
    instruction(route.swapInstruction, wallet),
    ...(route.cleanupInstruction ? [instruction(route.cleanupInstruction, wallet)] : []),
    ...route.otherInstructions.map((ix) => instruction(ix, wallet)),
  ]);
}

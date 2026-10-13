import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import "server-only";

import { PublicKey, TransactionInstruction, type Connection } from "@solana/web3.js";
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

export async function rejectUnselectedWalletTokenWrites(
  connection: Connection, wallet: PublicKey, instructions: TransactionInstruction[],
  allowedAccounts: string[],
) {
  const writable = [...new Map(instructions.flatMap((ix) => ix.keys.filter((key) => key.isWritable))
    .map((key) => [key.pubkey.toBase58(), key.pubkey])).values()];
  const allowed = new Set(allowedAccounts);
  const unselected = writable.filter((key) => !allowed.has(key.toBase58()));
  if (!unselected.length) return;
  const { value } = await connection.getMultipleAccountsInfoAndContext(unselected, "confirmed");
  value.forEach((info, index) => {
    if (!info || ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some((program) => info.owner.equals(program))) return;
    // A writable mint is not a wallet token account.
    if (info.data.length < 165 || info.data.length > 165 && info.data[165] !== 2) return;
    const decoded = unpackAccount(unselected[index]!, info, info.owner);
    if (decoded.owner.equals(wallet) && decoded.amount > 0n) throw new Error("Jupiter route may modify unselected wallet assets, transaction stopped");
  });
}

import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import "server-only";

import { PublicKey, TransactionInstruction, TransactionMessage, type VersionedTransaction, type Connection } from "@solana/web3.js";
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

export const JUPITER_PROGRAM_ID = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
export type IntermediateAccount = { address: string; program: string; mint: string; amount: bigint };

/** Funded unselected wallet accounts may only be written by Jupiter itself.
 * Callers must verify the returned balances in the complete simulation. */
export async function rejectUnselectedWalletTokenWrites(
  connection: Connection, wallet: PublicKey, instructions: TransactionInstruction[],
  allowedAccounts: string[],
) {
  const writable = [...new Map(instructions.flatMap((ix) => ix.keys.filter((key) => key.isWritable))
    .map((key) => [key.pubkey.toBase58(), key.pubkey])).values()];
  const allowed = new Set([...allowedAccounts, wallet.toBase58()]);
  const unselected = writable.filter((key) => !allowed.has(key.toBase58()));
  if (!unselected.length) return { accounts: [] as IntermediateAccount[], slot: 0 };
  const { value, context } = await connection.getMultipleAccountsInfoAndContext(unselected, "confirmed");
  if (value.length !== unselected.length) throw new Error("Unselected writable accounts could not be verified");
  const accounts: IntermediateAccount[] = [];
  value.forEach((info, index) => {
    if (!info || ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some((program) => info.owner.equals(program))) return;
    // A writable mint is not a wallet token account.
    if (info.data.length < 165 || info.data.length > 165 && info.data[165] !== 2) return;
    const decoded = unpackAccount(unselected[index]!, info, info.owner);
    if (!decoded.owner.equals(wallet) || decoded.amount === 0n) return;
    const address = unselected[index]!.toBase58();
    if (instructions.some(ix => !ix.programId.equals(JUPITER_PROGRAM_ID) && ix.keys.some(key => key.isWritable && key.pubkey.toBase58() === address))) {
      throw new Error(`Jupiter route may modify unselected wallet assets (${address}), transaction stopped`);
    }
    accounts.push({ address, program: info.owner.toBase58(), mint: decoded.mint.toBase58(), amount: decoded.amount });
  });
  return { accounts, slot: context.slot };
}

/** Inspect the actual transaction, including ALT keys, on preparation and signed
 * re-simulation. Never trust client-provided intermediate account metadata. */
export async function transactionIntermediateAccounts(connection: Connection, transaction: VersionedTransaction, wallet: PublicKey, allowed: string[]) {
  const tables = await Promise.all(transaction.message.addressTableLookups.map(async lookup => {
    const result = await connection.getAddressLookupTable(lookup.accountKey, { commitment: "confirmed" });
    if (!result.value || !result.value.isActive()) throw new Error("Intermediate account lookup table unavailable");
    return result.value;
  }));
  const { instructions } = TransactionMessage.decompile(transaction.message, { addressLookupTableAccounts: tables });
  return rejectUnselectedWalletTokenWrites(connection, wallet, instructions, allowed);
}

export function verifyIntermediateAccounts(accounts: IntermediateAccount[], addresses: string[], simulated: ({ data: string[]; owner: string; lamports: number; executable: boolean; rentEpoch?: number } | null)[] | null | undefined, wallet: PublicKey) {
  for (const before of accounts) {
    const fail = () => new Error(`Simulation could not preserve intermediate wallet assets (${before.address})`);
    const after = simulated?.[addresses.indexOf(before.address)];
    if (!after || after.owner !== before.program || after.executable || after.data[1] !== "base64" || !after.data[0]) throw fail();
    try {
      const token = unpackAccount(new PublicKey(before.address), { ...after, owner: new PublicKey(after.owner), data: Buffer.from(after.data[0], "base64"), rentEpoch: after.rentEpoch ?? 0 }, new PublicKey(before.program));
      if (!token.owner.equals(wallet) || token.mint.toBase58() !== before.mint || token.amount < before.amount || !token.isInitialized || token.isFrozen) throw fail();
    } catch { throw fail(); }
  }
}

/** Jupiter ExactIn user sources may be replaced only at their exact writable key.
 * Source ATA setup is omitted; its fresh isolated account is initialized by the caller.
 * Other setup/cleanup must not touch that source. Used by compound and withdraw. */
export function retargetSwapSource(route: BuildRoute, sourceAta: string, source: string): BuildRoute {
 if (!route.swapInstruction.accounts.some(key=>key.pubkey===sourceAta && key.isWritable)) throw new Error("Jupiter route does not identify isolated swap source");
 const touchesSource=(ix:ApiInstruction)=>ix.accounts.some(key=>key.pubkey===sourceAta);
 const setupInstructions=route.setupInstructions.filter(ix=>{
  if(!touchesSource(ix))return true;
  if(ix.programId!=="ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" || ix.accounts[1]?.pubkey!==sourceAta)throw new Error("Unsupported isolated source setup");
  return false;
 });
 if(route.cleanupInstruction && touchesSource(route.cleanupInstruction) || route.otherInstructions.some(touchesSource))throw new Error("Unsupported isolated source cleanup");
 return {...route,setupInstructions,swapInstruction:{...route.swapInstruction,accounts:route.swapInstruction.accounts.map(key=>key.pubkey===sourceAta?{...key,pubkey:source}:key)}};
}

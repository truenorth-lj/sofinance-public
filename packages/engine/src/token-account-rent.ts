import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import {
  ExtensionType, getAccountLen, getAccountTypeOfMintType, getExtensionTypes, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackMint,
} from "@solana/spl-token";

/**
 * Mint extensions for which Token-2022's `InitializeAccount` requires account-side extensions
 * (`ExtensionType::required_init_account_extensions` in token-2022 interface/src/extension/mod.rs):
 *   TransferFeeConfig → TransferFeeAmount, NonTransferable → NonTransferableAccount + ImmutableOwner,
 *   TransferHook → TransferHookAccount, Pausable (`PausableConfig` in @solana/spl-token) → PausableAccount.
 * Every other mint extension adds nothing. ImmutableOwner is pushed separately below: the Associated Token Program
 * initializes it on every Token-2022 account, so NonTransferable's ImmutableOwner is already covered.
 * The SDK's `getAccountLenForMint` cannot be used: it maps every mint extension through `getAccountTypeOfMintType`,
 * including ConfidentialTransferMint → ConfidentialTransferAccount, which an associated-account create does not add
 * (a confidential account needs its own opt-in); for the RWA mints it returns 478 bytes where the chain creates 179.
 * The list is pinned by token-account-rent.test.ts.
 * https://github.com/solana-program/token-2022/blob/main/interface/src/extension/mod.rs
 */
export const REQUIRED_INIT_MINT_EXTENSIONS = new Set([
  ExtensionType.TransferFeeConfig, ExtensionType.NonTransferable, ExtensionType.TransferHook, ExtensionType.PausableConfig,
]);

/** Data size of the associated token account the Associated Token Program creates for `mint`, read from its owner program and extensions. */
export function associatedTokenAccountSpace(mintAddress: PublicKey, mintInfo: AccountInfo<Buffer> | null, program: PublicKey): number {
  if (!program.equals(TOKEN_PROGRAM_ID) && !program.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(`Mint ${mintAddress.toBase58()} is owned by ${program.toBase58()}, not a token program.`);
  }
  const mint = unpackMint(mintAddress, mintInfo, program);
  const extensions = getExtensionTypes(mint.tlvData).filter((type) => REQUIRED_INIT_MINT_EXTENSIONS.has(type)).map(getAccountTypeOfMintType);
  // The Associated Token Program always initializes ImmutableOwner on a Token-2022 account.
  if (program.equals(TOKEN_2022_PROGRAM_ID)) extensions.push(ExtensionType.ImmutableOwner);
  return getAccountLen(extensions);
}

/**
 * Data size of the largest associated token account any Token-2022 mint can make the Associated Token Program create:
 * every required-init account extension plus ImmutableOwner. For accounts whose mint is not known in advance (a swap
 * route's intermediate accounts).
 */
export function maxAssociatedTokenAccountSpace(): number {
  return getAccountLen([...[...REQUIRED_INIT_MINT_EXTENSIONS].map(getAccountTypeOfMintType), ExtensionType.ImmutableOwner]);
}

export type TokenAccountRentConnection = Pick<Connection, "getMultipleAccountsInfo" | "getMinimumBalanceForRentExemption">;

/**
 * Rent of a new associated token account per mint, in input order: each mint is read on chain, its owner program is the
 * one the account is created under, and the size follows its extensions. Throws when a mint is missing.
 */
export async function associatedTokenAccountRents(connection: TokenAccountRentConnection, mints: string[]): Promise<{ mint: string; space: number; rentLamports: bigint }[]> {
  if (!mints.length) return [];
  const infos = await connection.getMultipleAccountsInfo(mints.map((mint) => new PublicKey(mint)), "confirmed");
  const spaces = mints.map((mint, index) => {
    const info = infos[index];
    if (!info) throw new Error(`Token mint ${mint} was not found on chain.`);
    return associatedTokenAccountSpace(new PublicKey(mint), info, info.owner);
  });
  const bySpace = new Map<number, bigint>();
  for (const space of new Set(spaces)) bySpace.set(space, BigInt(await connection.getMinimumBalanceForRentExemption(space, "confirmed")));
  return mints.map((mint, index) => ({ mint, space: spaces[index]!, rentLamports: bySpace.get(spaces[index]!)! }));
}

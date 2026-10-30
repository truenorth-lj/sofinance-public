// Fee-wallet account checks shared by `jupiter.ts` (buildRoute) and `collection.ts`.
// Split out of `collection.ts` so `jupiter.ts` no longer imports `collection.ts` (import cycle);
// the code below is moved verbatim and `collection.ts` re-exports every name.
import { createAssociatedTokenAccountIdempotentInstruction, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { PublicKey, type Connection } from "@solana/web3.js";
import { NATIVE_SOL_MINT, USDC_MINT } from "../ids";
import { swapFeeRecipientAta } from "./fee";

/** Creates only a missing recipient ATA. Invalid/frozen accounts fail closed. */
export async function feeAccountSetup(connection: Connection, payer: PublicKey, recipient: PublicKey,
  mint = new PublicKey(USDC_MINT), program = TOKEN_PROGRAM_ID) {
  const address = swapFeeRecipientAta(recipient, mint, program);
  const info = await connection.getAccountInfo(address, "confirmed");
  if (info) {
    const account = unpackAccount(address, info, program);
    if (!account.isInitialized || account.isFrozen || !account.mint.equals(mint) || !account.owner.equals(recipient))
      throw new Error("Protocol fee ATA is invalid or frozen");
  }
  return { address, instructions: info ? [] : [createAssociatedTokenAccountIdempotentInstruction(payer, address, recipient, mint, program)] };
}

export class SwapFeeAccountMissingError extends Error {
  readonly code = "protocol_fee_account_missing";
  constructor(nativeSol = true) {
    super(nativeSol
      ? "Protocol fee wSOL account is not set up, so SOL input is unavailable right now. No transaction was built; please use another token."
      : "Protocol fee account for this input token is not set up, so it is unavailable as input right now. No transaction was built; please use another token.");
    this.name = "SwapFeeAccountMissingError";
  }
}

/** Native SOL input pays its fee inside the Jupiter swap into the fee wallet's
 * wSOL ATA, which the operator pre-creates. Never create it in the user's
 * transaction and never redirect the fee elsewhere: a missing or invalid
 * account fails closed before any transaction is built. */
export async function requireSwapFeeAccount(connection: Connection, recipient: PublicKey,
  mint = new PublicKey(NATIVE_SOL_MINT), program = TOKEN_PROGRAM_ID) {
  const address = swapFeeRecipientAta(recipient, mint, program);
  const info = await connection.getAccountInfo(address, "confirmed");
  if (!info) throw new SwapFeeAccountMissingError(mint.toBase58() === NATIVE_SOL_MINT);
  const account = unpackAccount(address, info, program);
  if (!account.isInitialized || account.isFrozen || !account.mint.equals(mint) || !account.owner.equals(recipient))
    throw new Error("Protocol fee ATA is invalid or frozen");
  return address;
}

/** Deposit input fee (any input mint: SOL, USDC, stock tokens): Jupiter takes
 * `platformFeeBps` of the swapped input into the fee wallet's pre-created ATA
 * for that mint (SPL or Token-2022, resolved from the mint's owner program).
 * Never created in the user's transaction: missing fails closed. */
export async function requireInputFeeAccount(connection: Connection, recipient: PublicKey, mint: PublicKey) {
  if (mint.toBase58() === NATIVE_SOL_MINT) return requireSwapFeeAccount(connection, recipient, mint, TOKEN_PROGRAM_ID);
  const info = await connection.getAccountInfo(mint, "confirmed");
  if (!info || !(info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID)))
    throw new Error("Protocol fee mint program is not SPL Token or Token-2022");
  return requireSwapFeeAccount(connection, recipient, mint, info.owner);
}

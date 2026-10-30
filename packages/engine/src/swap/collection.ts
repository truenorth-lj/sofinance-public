import { ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, SystemProgram, type VersionedTransaction, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { versionedTransactionSize } from "../open-transaction";
import { NATIVE_SOL_MINT, USDC_MINT } from "../ids";
import { buildRoute, type BuildRoute } from "./jupiter";
import { retargetSwapSource, swapRouteInstructions } from "./instructions";
import { NativeSolFeeTransferError, nativeSolOwnerAta, swapFeeTransferInstructions, unfundedSwapFeeAtaRent, type SwapFeeTransferInput } from "./fee";
import { exceedsTxSizeLimit } from "../transaction-limits";
import { feeAccountSetup } from "./fee-accounts";
import { JUPITER_MAX_ACCOUNTS } from "../jupiter-route-retry";

export { feeAccountSetup, requireInputFeeAccount, requireSwapFeeAccount, SwapFeeAccountMissingError } from "./fee-accounts";

/** Deposits (open / selected add), whatever the input mint, never use a
 * transfer from this module: the fee is Jupiter `platformFeeBps` on each
 * swap leg from the input mint, paid into the fee wallet's pre-created ATA for
 * that mint (see `feeSwapLeg` / `buildRoute` / `requireInputFeeAccount`).
 * Compound rebalance still uses `collectCompoundSwapFee` (TransferChecked). Withdraw conversion to a non-USDC mint
 * still uses this USDC hop, with `fitFeeCollections` as the measured oversize
 * fallback. USDC withdraw keeps Jupiter `platformFee` instead. */
/** `receiveOnlyAccounts`: Jupiter's non-shared `route` instruction always marks
 * the user's output-mint ATA writable (userDestinationTokenAccount) even when
 * destinationTokenAccount redirects the output to the fee wallet. It is never
 * debited, so callers may exempt it from the unselected-asset write guard. */
export type FeeCollection = { instructions: TransactionInstruction[]; routes: BuildRoute[]; input?: SwapFeeTransferInput; receiveOnlyAccounts?: string[] };

/** Wrap native SOL into the owner's own wSOL ATA once for all swap legs (same
 * create/transfer/sync sequence Jupiter itself emits). Jupiter then debits each
 * leg, including its input-mint platform fee, from that account. */
export function wrapNativeSolInstructions(owner: PublicKey, lamports: bigint): TransactionInstruction[] {
  if (lamports <= 0n) return [];
  const ata = nativeSolOwnerAta(owner);
  const mint = new PublicKey(NATIVE_SOL_MINT);
  return [
    createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, mint, TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata, lamports }),
    createSyncNativeInstruction(ata),
  ];
}

export async function collectSwapFee(connection: Connection, input: SwapFeeTransferInput,
  inputTokenFallback = false): Promise<FeeCollection> {
  if (input.amount <= 0n) return { instructions: [], routes: [] };
  // Native SOL is charged inside the Jupiter swap; never as our own transfer.
  if (input.kind === "native") throw new NativeSolFeeTransferError();
  const usdc = new PublicKey(USDC_MINT);
  if (input.kind === "token" && (input.mint.equals(usdc) || inputTokenFallback)) {
    const setup = await feeAccountSetup(connection, input.payer, input.recipient, input.mint, input.program);
    return { instructions: [...setup.instructions, ...swapFeeTransferInstructions(input)], routes: [] };
  }
  const setup = await feeAccountSetup(connection, input.payer, input.recipient);
  const mint = input.mint.toBase58();
  let route = await buildRoute(input.owner.toBase58(), mint, USDC_MINT, input.amount,
    false, { maxAccounts: JUPITER_MAX_ACCOUNTS.feeRoute, onlyDirectRoutes: true }, undefined, undefined, setup.address.toBase58());
  const sourceAta=getAssociatedTokenAddressSync(input.mint,input.owner,true,input.program).toBase58();
  if(input.source.toBase58()!==sourceAta)route=retargetSwapSource(route,sourceAta,input.source.toBase58());
  const userUsdc = getAssociatedTokenAddressSync(usdc, input.owner, true, TOKEN_PROGRAM_ID).toBase58();
  return { instructions: [...setup.instructions, ...swapRouteInstructions([route], input.owner)], routes: [route], input, receiveOnlyAccounts: [userUsdc] };
}

/** Prefer USDC, then measured input-asset fallback. Used by withdraw conversion
 * when the extra hop does not fit.
 * Never split collection into a separately submitted transaction. */
export async function fitFeeCollections(connection: Connection, collections: FeeCollection[],
  instructions: TransactionInstruction[], compile: (ixs: TransactionInstruction[]) => VersionedTransaction) {
  const measured = versionedTransactionSize(compile(instructions));
  if (!exceedsTxSizeLimit(measured) || !collections.some(c => c.input)) return { instructions, usdcCandidateBytes: measured, fallback: false };
  let result = instructions;
  for (const collection of collections) {
    if (!collection.input) continue;
    const fallback = await collectSwapFee(connection, collection.input, true);
    const removed = new Set(collection.instructions);
    const first = result.findIndex(ix => removed.has(ix));
    if (first < 0) throw new Error("Protocol fee collection instructions missing");
    result = [...result.slice(0, first), ...fallback.instructions, ...result.slice(first).filter(ix => !removed.has(ix))];
  }
  return { instructions: result, usdcCandidateBytes: measured, fallback: true };
}

/** Budget the recipient accounts actually retained after size fallback. */
export async function feeRecipientRent(connection: Connection, recipient: PublicKey,
  instructions: TransactionInstruction[]): Promise<bigint> {
  const creates = new Map(instructions.filter(ix => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) &&
    ix.keys[2]?.pubkey.equals(recipient)).map(ix => [ix.keys[1]!.pubkey.toBase58(), ix]));
  const rents = await Promise.all([...creates.values()].map(ix =>
    unfundedSwapFeeAtaRent(connection, recipient, ix.keys[3]!.pubkey, ix.keys[5]!.pubkey)));
  return rents.reduce((sum, rent) => sum + rent, 0n);
}

/** 10 bps of a deposited (or compound-swap) token input, transferred to the
 * fee wallet's ATA for that mint. Creates a missing ATA with the user as payer.
 * Native SOL input is rejected here; its fee is taken inside the Jupiter swap. */
export async function collectInputAssetFee(connection: Connection, input: SwapFeeTransferInput) {
  return collectSwapFee(connection, input, true);
}

/** Compound rebalance uses the same input-asset transfer as open / selected add. */
export async function collectCompoundSwapFee(connection: Connection, input: SwapFeeTransferInput) {
  return collectInputAssetFee(connection, input);
}

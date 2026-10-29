import { engineEnv } from "../host";
// Shared rate configuration and explicit transfer primitives. Collection policy
// lives in collection.ts; callers must not silently waive missing recipient ATAs.
import {
  createTransferCheckedInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID, getAccountLenForMint, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackMint,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { NATIVE_SOL_MINT } from "../ids";

export const DEFAULT_SWAP_FEE_BPS = 10;
export const MAX_SWAP_FEE_BPS = 100;

export type SwapFeeConfig = {
  wallet: PublicKey | null;
  bps: number;
};

export type SwapFeeQuote = {
  feeBps: number;
  feeAmount: string;
  feeWallet: string | null;
};

export type SwapFeeTransferInput = {
  payer: PublicKey;
  owner: PublicKey;
  recipient: PublicKey;
  amount: bigint;
} & (
  | { kind: "native" }
  | { kind: "token"; mint: PublicKey; source: PublicKey; decimals: number; program: PublicKey }
);

export function parseSwapFeeBps(value: string | undefined): number {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_SWAP_FEE_BPS;
  if (!/^\d+$/.test(trimmed)) throw new Error("SOFINANCE_FEE_BPS must be an integer 0-100");
  const bps = Number(trimmed);
  if (!Number.isInteger(bps) || bps < 0) throw new Error("SOFINANCE_FEE_BPS must be an integer 0-100");
  return Math.min(bps, MAX_SWAP_FEE_BPS);
}

export function parseSwapFeeWallet(value: string | undefined): PublicKey | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    return new PublicKey(trimmed);
  } catch {
    throw new Error("SOFINANCE_FEE_WALLET is not a valid Solana address");
  }
}

/** Set (server-only) by `runWithSwapFeePaidUpstream` in `../fee-waiver.ts`. Read
 * through globalThis so this module stays free of `node:async_hooks`. */
function swapFeePaidUpstream(): boolean {
  const holder = globalThis as { __sofiSwapFeePaidUpstream?: { getStore(): unknown } };
  return holder.__sofiSwapFeePaidUpstream?.getStore() === true;
}

export function readSwapFeeConfig(): SwapFeeConfig {
  // Step 2/2 of a two-transaction SOL open: the 10 bps was already charged
  // inside the step-1 Jupiter swap, so the token-input open charges nothing.
  if (swapFeePaidUpstream()) return { wallet: null, bps: 0 };
  const wallet = parseSwapFeeWallet(engineEnv().SOFINANCE_FEE_WALLET);
  if (!wallet) return { wallet: null, bps: 0 };
  return { wallet, bps: parseSwapFeeBps(engineEnv().SOFINANCE_FEE_BPS) };
}

export function computeSwapFee(amount: bigint, bps: number): bigint {
  if (amount < 0n) throw new Error("Swap fee amount must be non-negative");
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_SWAP_FEE_BPS) throw new Error("Invalid swap fee bps");
  return amount * BigInt(bps) / 10_000n;
}

export function netSwapInput(amount: bigint, bps: number): { feeAmount: bigint; swapAmount: bigint } {
  const feeAmount = computeSwapFee(amount, bps);
  const swapAmount = amount - feeAmount;
  if (feeAmount > 0n && swapAmount <= 0n) throw new Error("Swap amount too small to apply protocol fee");
  return { feeAmount, swapAmount };
}

export function swapFeeQuoteFields(amount: bigint, config: SwapFeeConfig): SwapFeeQuote {
  return {
    feeBps: config.bps,
    feeAmount: computeSwapFee(amount, config.bps).toString(),
    feeWallet: config.wallet?.toBase58() ?? null,
  };
}

export function nativeSolOwnerAta(owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(new PublicKey(NATIVE_SOL_MINT), owner, false, TOKEN_PROGRAM_ID);
}

export function swapFeeRecipientAta(recipient: PublicKey, mint: PublicKey, program: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, recipient, true, program);
}

/** Native SOL fees are never a separate transfer: they are collected inside the
 * Jupiter swap (`platformFeeBps` + the fee wallet's pre-created wSOL ATA as
 * `feeAccount`). A direct SOL/wSOL transfer to the fee wallet is what Phantom
 * flags as malicious, so this refuses to build one. */
export class NativeSolFeeTransferError extends Error {
  constructor() {
    super("Native SOL protocol fee must be collected inside the Jupiter swap, not by a direct transfer");
    this.name = "NativeSolFeeTransferError";
  }
}

export function swapFeeTransferInstructions(input: SwapFeeTransferInput): TransactionInstruction[] {
  if (input.amount <= 0n) return [];
  if (input.kind === "native") throw new NativeSolFeeTransferError();
  const ata = swapFeeRecipientAta(input.recipient, input.mint, input.program);
  return [
    createTransferCheckedInstruction(
      input.source, input.mint, ata, input.owner, input.amount, input.decimals, [], input.program,
    ),
  ];
}

export async function unfundedSwapFeeAtaRent(
  connection: Connection,
  recipient: PublicKey,
  mint: PublicKey,
  program: PublicKey,
): Promise<bigint> {
  const ata = swapFeeRecipientAta(recipient, mint, program);
  const [ataInfo, mintInfo] = await connection.getMultipleAccountsInfo([ata, mint], "confirmed");
  if (ataInfo) return 0n;
  if (!mintInfo || !mintInfo.owner.equals(program)) throw new Error("Fee mint program mismatch");
  const space = getAccountLenForMint(unpackMint(mint, mintInfo, program));
  return BigInt(await connection.getMinimumBalanceForRentExemption(space, "confirmed"));
}

/** Resolve rate without waiving collection when recipient setup is needed. */
export async function resolveSwapFeeConfig(_connection: Connection, _mint: PublicKey, _program: PublicKey,
  _native = false): Promise<SwapFeeConfig> {
  void _native;
  return readSwapFeeConfig();
}

/** Do not accept an upstream quote that silently omitted the requested fee. */
export function assertPlatformFeeQuote(quote: { platformFee?: unknown }, bps: number) {
  if (!bps) return;
  const fee = quote.platformFee as { feeBps?: number; amount?: string } | null;
  if (!fee || fee.feeBps !== bps || typeof fee.amount !== "string" || !/^\d+$/.test(fee.amount))
    throw new Error("Jupiter quote protocol fee does not match configuration");
}

/** Deposit transactions must never move tokens or SOL to the fee wallet with
 * their own top-level instruction, nor create a fee-wallet account: the fee is
 * paid only inside the Jupiter swap (input-mint platform fee). A direct
 * transfer to the fee wallet is what Phantom flags as "Request blocked". */
export function assertNoDirectFeeWalletInstructions(instructions: TransactionInstruction[], feeWallet: PublicKey | null) {
  if (!feeWallet) return;
  const tokenPrograms = [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()];
  for (const ix of instructions) {
    const program = ix.programId.toBase58();
    if (program === SystemProgram.programId.toBase58() && ix.data.length >= 4 && ix.data.readUInt32LE(0) === 2 &&
      ix.keys[1]?.pubkey.equals(feeWallet)) throw new DirectFeeWalletInstructionError();
    if (program === ASSOCIATED_TOKEN_PROGRAM_ID.toBase58() && ix.keys[2]?.pubkey.equals(feeWallet)) throw new DirectFeeWalletInstructionError();
    if (tokenPrograms.includes(program) && ix.keys.some(key => key.pubkey.equals(feeWallet))) throw new DirectFeeWalletInstructionError();
    if (tokenPrograms.includes(program) && (ix.data[0] === 3 || ix.data[0] === 12)) {
      const destination = ix.data[0] === 3 ? ix.keys[1]?.pubkey : ix.keys[2]?.pubkey;
      const mint = ix.data[0] === 12 ? ix.keys[1]?.pubkey : null;
      if (destination && mint && swapFeeRecipientAta(feeWallet, mint, ix.programId).equals(destination)) throw new DirectFeeWalletInstructionError();
    }
  }
}

export class DirectFeeWalletInstructionError extends Error {
  constructor() {
    super("Deposit transaction must not transfer to or create accounts for the protocol fee wallet directly");
    this.name = "DirectFeeWalletInstructionError";
  }
}

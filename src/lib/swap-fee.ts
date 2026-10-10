// Explicit SPL/SOL transfer to SOFINANCE_FEE_WALLET. Jupiter platformFeeBps
// needs a Referral-program feeAccount, not an arbitrary wallet ATA, and cannot
// cover the in-pool Raydium compound swap.
import {
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
  getAccountLenForMint, getAssociatedTokenAddressSync, unpackMint,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, type Connection, type TransactionInstruction } from "@solana/web3.js";

export const DEFAULT_SWAP_FEE_BPS = 20;
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

export function readSwapFeeConfig(): SwapFeeConfig {
  const wallet = parseSwapFeeWallet(process.env.SOFINANCE_FEE_WALLET);
  if (!wallet) return { wallet: null, bps: 0 };
  return { wallet, bps: parseSwapFeeBps(process.env.SOFINANCE_FEE_BPS) };
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

export function swapFeeRecipientAta(recipient: PublicKey, mint: PublicKey, program: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, recipient, true, program);
}

export function swapFeeTransferInstructions(input: SwapFeeTransferInput): TransactionInstruction[] {
  if (input.amount <= 0n) return [];
  if (input.kind === "native") {
    return [SystemProgram.transfer({ fromPubkey: input.owner, toPubkey: input.recipient, lamports: input.amount })];
  }
  const ata = swapFeeRecipientAta(input.recipient, input.mint, input.program);
  return [
    createAssociatedTokenAccountIdempotentInstruction(input.payer, ata, input.recipient, input.mint, input.program),
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

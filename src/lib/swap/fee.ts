// Atomic input-asset transfers preserve native SOL receipts and Raydium swaps.
// Jupiter platform fees are supported, but require token accounts (including WSOL).
import {
  createTransferCheckedInstruction,
  getAccountLenForMint, getAssociatedTokenAddressSync, unpackMint, unpackAccount,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, type Connection, type TransactionInstruction } from "@solana/web3.js";

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

export async function assertNativeSwapFeeRecipient(connection: Connection, recipient: PublicKey, fee: bigint) {
  if (fee <= 0n) return;
  const account = await connection.getAccountInfo(recipient, "confirmed");
  const minimum = BigInt(await connection.getMinimumBalanceForRentExemption(account?.data.length ?? 0, "confirmed"));
  if (BigInt(account?.lamports ?? 0) + fee < minimum) {
    throw new Error(`Protocol fee wallet is not funded for account rent. The site operator must fund the fee wallet with at least ${Number(minimum) / 1e9} SOL; no transaction was sent`);
  }
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

/** Missing operator token accounts disable collection; users never pay operator rent. */
export async function resolveSwapFeeConfig(connection: Connection, mint: PublicKey, program: PublicKey,
  native = false): Promise<SwapFeeConfig> {
  const config = readSwapFeeConfig();
  if (!config.wallet || config.bps === 0 || native) return config;
  const address = swapFeeRecipientAta(config.wallet, mint, program);
  const info = await connection.getAccountInfo(address, "confirmed");
  if (!info) return { ...config, bps: 0 };
  const account = unpackAccount(address, info, program);
  if (!account.mint.equals(mint) || !account.owner.equals(config.wallet) || account.isFrozen)
    throw new Error("Protocol fee ATA is invalid or frozen");
  return config;
}

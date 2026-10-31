import { formatAmountDisplay } from "./amount";
import { NATIVE_SOL_MINT, USDC_MINT } from "./ids";

/**
 * Plain-words balance errors. One message per cause, so a person can tell which balance is short:
 * the token they entered, or the SOL kept back for network fees.
 */
export const NOT_ENOUGH_SOL_FOR_FEES_MESSAGE = "Not enough SOL for network fees: keep at least 0.01 SOL in your wallet to pay fees and any new token account.";

/** Symbol for a mint when no token metadata is at hand. */
export function knownTokenSymbol(mint: string, inputKind?: "native" | "token"): string | null {
  if (inputKind === "native" || mint === NATIVE_SOL_MINT && inputKind !== "token") return "SOL";
  if (mint === NATIVE_SOL_MINT) return "WSOL";
  if (mint === USDC_MINT) return "USDC";
  return null;
}

/** "Not enough INTCy (you have 0, entered 10.957663)"; native SOL says the fee reserve is already set aside. */
export function notEnoughBalanceMessage(input: {
  symbol?: string | null; decimals: number; balance: bigint | string; requested: bigint | string; native?: boolean;
}): string {
  const have = formatAmountDisplay(BigInt(input.balance), input.decimals);
  const entered = formatAmountDisplay(BigInt(input.requested), input.decimals);
  if (input.native) return `Not enough SOL (you can use ${have} SOL after keeping some for network fees, entered ${entered})`;
  const symbol = input.symbol?.trim();
  return symbol ? `Not enough ${symbol} (you have ${have}, entered ${entered})`
    : `Not enough of this token in your wallet (you have ${have}, entered ${entered})`;
}

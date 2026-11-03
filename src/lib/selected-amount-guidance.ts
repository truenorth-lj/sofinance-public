import { parseTokenAmount } from "@sofinance/engine/amount";

/** After Withdraw 100% the position stays listed with no liquidity; the add form says that instead of asking for an amount. */
export const CLOSED_POSITION_ADD_MESSAGE = "This position was fully withdrawn, so it has no liquidity to add to. Choose another position, or open a new one from Pools.";
export const ENTER_AMOUNT_MESSAGE = "Enter an amount to add.";
export const AMOUNT_ABOVE_ZERO_MESSAGE = "Enter an amount above zero.";
export const AMOUNT_NOT_A_NUMBER_MESSAGE = "Enter the amount as a number, for example 1.5.";
export const tooManyDecimalsMessage = (decimals: number) =>
  decimals === 0 ? "This token has no decimal places. Enter a whole number." : `This token allows at most ${decimals} decimal places. Shorten the amount.`;

/**
 * The real reason the Add amount cannot be used yet, in plain words (replaces "Please enter input amount matching asset
 * precision", PR10), or null when the amount is a usable positive amount of a position that still has liquidity.
 */
export function addAmountGuidance(amount: string, decimals: number, liquidity?: string): string | null {
  if (liquidity === "0") return CLOSED_POSITION_ADD_MESSAGE;
  const text = amount.trim();
  if (!text) return ENTER_AMOUNT_MESSAGE;
  if (/^0*\.?0*$/.test(text.replace(/,/g, ""))) return AMOUNT_ABOVE_ZERO_MESSAGE;
  let raw: bigint;
  try {
    raw = parseTokenAmount(text, decimals);
  } catch {
    const fraction = /^\d*\.(\d+)$/.exec(text.replace(/,/g, ""));
    return fraction && fraction[1]!.length > decimals ? tooManyDecimalsMessage(decimals) : AMOUNT_NOT_A_NUMBER_MESSAGE;
  }
  return raw > 0n ? null : AMOUNT_ABOVE_ZERO_MESSAGE;
}

/**
 * The one "too small for this range" rule for Open and Add (client-safe, no DEX knowledge). The adapter works out
 * `DepositMinimum` at quote time (quote-open / quote-add); this turns it into the button state and the plain line.
 */
import type { DepositMinimum } from "./adapter";

export const DEPOSIT_TOO_SMALL_PREFIX = "This amount is too small to add to every price step in this range.";

/** Significant figures of the shown minimum. */
const MINIMUM_SIGNIFICANT_FIGURES = 3;

/**
 * The threshold itself, shown in whole tokens: `raw` rounded UP to 3 significant figures (e.g. 25,119 raw USDC → "0.0252",
 * 48,336 → "0.0484"; 3 digits or fewer are exact). No headroom on top: any buffer belongs in the threshold (the rule's
 * margin). The shown number is the smallest 3-significant-figure amount ≥ the threshold, so entering it always passes
 * the same check (`amount < minimumRaw` is false).
 */
export function minimumDisplay(raw: bigint, decimals: number): string {
  if (raw <= 0n) return "0";
  const digits = raw.toString().length;
  const step = digits > MINIMUM_SIGNIFICANT_FIGURES ? 10n ** BigInt(digits - MINIMUM_SIGNIFICANT_FIGURES) : 1n;
  const rounded = ((raw + step - 1n) / step) * step;
  const scale = 10n ** BigInt(decimals);
  const whole = rounded / scale;
  const fraction = decimals > 0 ? (rounded % scale).toString().padStart(decimals, "0").replace(/0+$/, "") : "";
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/**
 * The line to show (and a reason to disable Open / Add) when the quoted amount would round to 0 in some step of the
 * range; null when the amount is fine, the check is for another token, or the adapter has no minimum rule.
 */
export const DEPOSIT_MINIMUM_UNAVAILABLE = "We couldn't check whether this amount is enough for every price step right now. Try again in a moment.";

export function depositTooSmallMessage(minimum: DepositMinimum | null | undefined, token: { id: string; decimals: number; symbol: string | null } | null | undefined): string | null {
  if (!minimum?.tooSmall || !token || minimum.token !== token.id) return null;
  if (minimum.unavailable) return DEPOSIT_MINIMUM_UNAVAILABLE;
  const raw = minimum.minimumRaw && /^\d+$/.test(minimum.minimumRaw) ? BigInt(minimum.minimumRaw) : null;
  return raw && raw > 0n
    ? `${DEPOSIT_TOO_SMALL_PREFIX} Try at least ${minimumDisplay(raw, token.decimals)}${token.symbol ? ` ${token.symbol}` : ""}.`
    : `${DEPOSIT_TOO_SMALL_PREFIX} Try a larger amount.`;
}

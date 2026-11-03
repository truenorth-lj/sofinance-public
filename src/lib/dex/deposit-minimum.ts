/**
 * The one "too small for this range" rule for Open and Add (client-safe, no DEX knowledge). The adapter works out
 * `DepositMinimum` at quote time (quote-open / quote-add); this turns it into the button state and the plain line.
 */
import type { DepositMinimum } from "./adapter";

export const DEPOSIT_TOO_SMALL_PREFIX = "This amount is too small to add to every price step in this range.";

/** Headroom over the estimate: quotes move between the check and the build, and the build re-checks in simulation. */
const HEADROOM_PERCENT = 10n;

/**
 * `raw` plus 10% headroom, rounded UP to two significant figures in whole tokens (e.g. 48,336 raw USDC → "0.054").
 * Never rounds below the estimate.
 */
export function suggestedMinimum(raw: bigint, decimals: number): string {
  if (raw <= 0n) return "0";
  const padded = (raw * (100n + HEADROOM_PERCENT) + 99n) / 100n;
  const digits = padded.toString().length;
  const step = digits > 2 ? 10n ** BigInt(digits - 2) : 1n;
  const rounded = ((padded + step - 1n) / step) * step;
  const scale = 10n ** BigInt(decimals);
  const whole = rounded / scale;
  const fraction = (rounded % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/**
 * The line to show (and a reason to disable Open / Add) when the quoted amount would round to 0 in some step of the
 * range; null when the amount is fine, the check is for another token, or the adapter has no minimum rule.
 */
export function depositTooSmallMessage(minimum: DepositMinimum | null | undefined, token: { id: string; decimals: number; symbol: string | null } | null | undefined): string | null {
  if (!minimum?.tooSmall || !token || minimum.token !== token.id) return null;
  const raw = minimum.minimumRaw && /^\d+$/.test(minimum.minimumRaw) ? BigInt(minimum.minimumRaw) : null;
  return raw && raw > 0n
    ? `${DEPOSIT_TOO_SMALL_PREFIX} Try at least about ${suggestedMinimum(raw, token.decimals)}${token.symbol ? ` ${token.symbol}` : ""}.`
    : `${DEPOSIT_TOO_SMALL_PREFIX} Try a larger amount.`;
}

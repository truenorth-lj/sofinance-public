import Decimal from "decimal.js";
import type { Intent } from "./lp-intent";

export const DEFAULT_PLAN_DAYS = 30;
export const DEFAULT_PLAN_AMOUNT = "1000";
/** Owner default: +100 USDC on 1,000 (10%). */
export const DEFAULT_PLAN_TARGET_PCT = 10;
export const DEFAULT_PLAN_LOSS_ALERT_PCT = 5;
export const DEFAULT_PLAN_LOSS_ALERT = "50";

export function shareOfAmount(amount: string, pct: number): string {
  const share = new Decimal(amount).mul(pct).div(100).toDecimalPlaces(2);
  return share.lte(0) ? "0.000001" : share.toFixed();
}

export function percentOfAmount(part: string, whole: string): number {
  const w = new Decimal(whole);
  if (w.lte(0)) return 0;
  return new Decimal(part).div(w).mul(100).toNumber();
}

/**
 * Apply a plan-intent patch. Changing `amount` keeps the same target and
 * loss-alert percentages so a 1 → 10,000 edit does not leave the alert stuck
 * at the clamped $1 floor.
 */
export function applyIntentChange(current: Intent, patch: Partial<Intent>): Intent {
  const next: Intent = { ...current, ...patch };
  if (patch.amount !== undefined && patch.amount !== current.amount) {
    if (patch.target === undefined) {
      next.target = shareOfAmount(patch.amount, percentOfAmount(current.target, current.amount));
    }
    if (patch.lossAlert === undefined) {
      next.lossAlert = shareOfAmount(patch.amount, percentOfAmount(current.lossAlert, current.amount));
    }
  }
  if (new Decimal(next.lossAlert).gt(next.amount)) {
    next.lossAlert = next.amount;
  }
  return next;
}

import Decimal from "decimal.js";
import { parseDays, parseUsdc, type ExitAsset } from "./lp-intent";

export const DEFAULT_PLAN_DAYS = 30;
export const DEFAULT_PLAN_AMOUNT = "1000";
export const DEFAULT_PLAN_LOSS_ALERT_PCT = 5;
export const DEFAULT_PLAN_LOSS_ALERT = "50";

/**
 * What the user chooses on the Plan page: how much goes in and for how long. `lossAlert` and
 * `exitAsset` are optional preferences; they never change the projection.
 */
export type PlanSetup = {
  days: number;
  amount: string;
  lossAlert: string;
  exitAsset: ExitAsset;
};

export const DEFAULT_PLAN_SETUP: PlanSetup = {
  days: DEFAULT_PLAN_DAYS,
  amount: DEFAULT_PLAN_AMOUNT,
  lossAlert: DEFAULT_PLAN_LOSS_ALERT,
  exitAsset: "usdc",
};

export function shareOfAmount(amount: string, pct: number): string {
  const share = new Decimal(amount).mul(pct).div(100);
  const rounded = share.toDecimalPlaces(share.lt("0.01") ? 6 : 2);
  return rounded.lte(0) ? "0.000001" : rounded.toFixed();
}

export function percentOfAmount(part: string, whole: string): number {
  const w = new Decimal(whole);
  if (w.lte(0)) return 0;
  return new Decimal(part).div(w).mul(100).toNumber();
}

/**
 * Read a shared plan from query params: `amount`, `days`, `alert` and `exit`. Anything else,
 * including the retired goal-first params (`goal`, `target`, `aim`), is ignored, and an invalid
 * value falls back to the default instead of throwing.
 */
export function parsePlanSetup(params: URLSearchParams): PlanSetup {
  const amount = parseUsdc(params.get("amount") ?? "") ?? DEFAULT_PLAN_SETUP.amount;
  return {
    days: parseDays(params.get("days") ?? "") ?? DEFAULT_PLAN_SETUP.days,
    amount,
    lossAlert: parseUsdc(params.get("alert") ?? "", amount) ?? shareOfAmount(amount, DEFAULT_PLAN_LOSS_ALERT_PCT),
    exitAsset: params.get("exit") === "tokens" ? "tokens" : "usdc",
  };
}

/**
 * Apply a plan patch. Changing `amount` keeps the same loss-alert percentage so a 1 → 10,000 edit
 * does not leave the alert stuck at the clamped $1 floor.
 */
export function applyPlanChange(current: PlanSetup, patch: Partial<PlanSetup>): PlanSetup {
  const next: PlanSetup = { ...current, ...patch };
  if (patch.amount !== undefined && patch.amount !== current.amount && patch.lossAlert === undefined) {
    next.lossAlert = shareOfAmount(patch.amount, percentOfAmount(current.lossAlert, current.amount));
  }
  if (new Decimal(next.lossAlert).gt(next.amount)) {
    next.lossAlert = next.amount;
  }
  return next;
}

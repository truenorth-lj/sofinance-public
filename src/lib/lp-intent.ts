import Decimal from "decimal.js";

const D = Decimal.clone({ precision: 60 });
export const MAX_PLAN_DAYS = 365;
export const MAX_PLAN_USDC = "10000000";
export type ExitAsset = "usdc" | "tokens";

/** Accepts "1,000.50"-style input; returns a canonical positive decimal string or null. */
export function parseUsdc(input: string, max: string = MAX_PLAN_USDC): string | null {
  const text = input.replace(/[,\s]/g, "");
  if (!/^\d+(\.\d{0,6})?$/.test(text)) return null;
  const value = new D(text);
  if (value.lte(0) || value.gt(max)) return null;
  return value.toFixed();
}

export function parseDays(input: string): number | null {
  if (!/^\d{1,3}$/.test(input.trim())) return null;
  const days = Number(input.trim());
  return days >= 1 && days <= MAX_PLAN_DAYS ? days : null;
}

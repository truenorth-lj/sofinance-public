import { DEFAULT_ADD_TOLERANCE_BPS, DEFAULT_RESALE_FLOOR_BPS, LOWEST_RESALE_FLOOR_BPS, MAX_ADD_TOLERANCE_BPS } from "./ids";

export function parseTokenAmount(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("Asset precision exceeds supported range");
  if (!/^(0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new Error("Please enter a valid input amount");
  const [whole, fraction = ""] = value.split(".");
  if (whole === undefined || fraction.length > decimals) throw new Error(`Input amount can have at most ${decimals} decimal places`);
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (raw <= 0n || raw > 18_446_744_073_709_551_615n) throw new Error("Input amount exceeds supported range");
  return raw;
}

export function formatAmount(raw: bigint | string, decimals: number, digits = 6): string {
  const amount = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const fraction = (amount % scale).toString().padStart(decimals, "0").slice(0, digits).replace(/0+$/, "");
  return `${amount / scale}${fraction ? `.${fraction}` : ""}`;
}

export function meetsResaleFloor(spend: bigint, resale: bigint, floorBps: number): boolean {
  return spend > 0n && resale * 10_000n >= spend * BigInt(floorBps);
}

/** Allow Jupiter/CLMM underspend of up to 0.1%; still reject overspend. */
export const INPUT_UNDERSPEND_TOLERANCE_BPS = 10;

export function simulatedInputSpendMatches(spent: bigint, requested: bigint): boolean {
  if (spent <= 0n || spent > requested) return false;
  const slack = (requested * BigInt(INPUT_UNDERSPEND_TOLERANCE_BPS)) / 10_000n;
  const allowed = slack > 1n ? slack : 1n;
  return requested - spent <= allowed;
}

export function achievedResaleBps(spend: bigint, resale: bigint): number | null {
  if (spend <= 0n) return null;
  return Number((resale * 10_000n) / spend);
}

/** Largest floor (0.1% steps, ≥ 95%) that the conservative resale would still pass. */
export function suggestedResaleFloorBps(spend: bigint, resale: bigint): number {
  const achieved = achievedResaleBps(spend, resale);
  if (achieved === null) return LOWEST_RESALE_FLOOR_BPS;
  const rounded = Math.floor(achieved / 10) * 10;
  return Math.max(LOWEST_RESALE_FLOOR_BPS, Math.min(10_000, rounded));
}

export function maxSpendForResaleFloor(resale: bigint, floorBps: number): bigint {
  if (floorBps <= 0) return resale;
  return (resale * 10_000n) / BigInt(floorBps);
}

export function describeResaleFloorFailure(spend: bigint, resale: bigint, floorBps: number): {
  suggestedResaleFloorBps: number;
  maxAmountForFloor: string;
  achievedResaleBps: number | null;
  warning: string;
} {
  const suggested = suggestedResaleFloorBps(spend, resale);
  const maxAmount = maxSpendForResaleFloor(resale, floorBps);
  const achieved = achievedResaleBps(spend, resale);
  const achievedPct = achieved === null ? "—" : (achieved / 100).toFixed(2);
  const floorPct = (floorBps / 100).toFixed(2);
  const suggestedPct = (suggested / 100).toFixed(2);
  return {
    suggestedResaleFloorBps: suggested,
    maxAmountForFloor: maxAmount.toString(),
    achievedResaleBps: achieved,
    warning:
      `Conservative immediate resale is ${achievedPct}% of input, below the ${floorPct}% floor. ` +
      `Lower resaleFloorBps to ${suggested} (${suggestedPct}%) or reduce the amount to at most ${maxAmount.toString()} raw units.`,
  };
}

export function resaleFloorFromMaxCostPercent(value: string): number {
  if (!/^(?:[0-4](?:\.\d)?|5(?:\.0)?)$/.test(value)) throw new Error("Estimated resale gap must be 0-5%, at most one decimal place");
  const [whole, decimal = "0"] = value.split(".");
  return 10_000 - Number(whole) * 100 - Number(decimal) * 10;
}

export function parseResaleFloorBps(value: unknown): number {
  const floor = value === undefined ? DEFAULT_RESALE_FLOOR_BPS : value;
  if (typeof floor !== "number" || !Number.isInteger(floor) || floor < LOWEST_RESALE_FLOOR_BPS || floor > 10_000 || floor % 10 !== 0) throw new Error("Valuation threshold must be 95-100%, adjustable by 0.1% increments");
  return floor;
}

export function parseAddToleranceBps(value: unknown): number {
  const tolerance = value === undefined || value === null ? DEFAULT_ADD_TOLERANCE_BPS : value;
  if (typeof tolerance !== "number" || !Number.isInteger(tolerance) || tolerance < 0 ||
    tolerance > MAX_ADD_TOLERANCE_BPS || tolerance % 10 !== 0) {
    throw new Error(`Add-liquidity price tolerance must be 0-${MAX_ADD_TOLERANCE_BPS / 100}%, adjustable by 0.1% increments`);
  }
  return tolerance;
}

export function toleranceFromPercent(value: string): number {
  if (!/^(?:[0-4](?:\.\d)?|5(?:\.0)?)$/.test(value)) throw new Error("Price tolerance must be 0-5%, at most one decimal place");
  const [whole, decimal = "0"] = value.split(".");
  return Number(whole) * 100 + Number(decimal) * 10;
}

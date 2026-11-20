import Decimal from "decimal.js";

/**
 * Add value guard (client-safe, no DEX knowledge): before an Add is signed, the value that ends up with the user
 * (the deposit into the position plus the leftover buffer that stays in the wallet) must be at least
 * `ADD_VALUE_FLOOR_BPS` of the input's value. Values come from an independent USD price source (Jupiter Price API), never from the swap quote being checked, so a bad route or a pool priced away from the
 * market is caught whether or not the route goes through the target pool.
 *
 * A DEX opts in through its descriptor (`meta.addValueFloorBps`); the swap fee itself is unchanged (10 bps on the
 * swapped part) and counts against the floor like any other cost.
 */

/** 97%: PM is confirming the number with LJ (2026-11-15). The one place the threshold lives. */
export const ADD_VALUE_FLOOR_BPS = 9_700;

/** One token amount that leaves or reaches the user. `raw` is in base units; `usd` is the independent USD price. */
type ValuedAmount = { raw: bigint; decimals: number; usd: number | null };

type AddValueInput = {
  floorBps: number;
  input: ValuedAmount;
  /** What goes into the position, per pool token. */
  deposit: readonly ValuedAmount[];
  /** Swap output that stays in the wallet (the price-tolerance reserve), per pool token. */
  buffer: readonly ValuedAmount[];
  /**
   * The range is at most one tick-spacing step wide. The pool-price projection only runs when the route goes through
   * the target pool, so for these ranges a missing price blocks instead of skipping the check.
   */
  narrowRange: boolean;
};

type AddValueResult =
  | { kind: "ok"; inputUsd: number; deliveredUsd: number }
  | { kind: "too-low"; inputUsd: number; depositUsd: number; bufferUsd: number; message: string }
  | { kind: "unpriced"; message: string };

export const ADD_VALUE_UNPRICED_MESSAGE =
  "We couldn't check this add against market prices right now. Nothing was sent. Try again in a minute.";

export const ADD_VALUE_UNPRICED_NARROW_MESSAGE =
  "We couldn't check this add against market prices right now, and this position's range is too narrow to add " +
  "without that check. Nothing was sent. Try again in a minute.";

function usdOf(amount: ValuedAmount): Decimal | null {
  if (amount.raw === 0n) return new Decimal(0);
  if (amount.raw < 0n || amount.usd === null || !Number.isFinite(amount.usd) || amount.usd <= 0) return null;
  return new Decimal(amount.raw.toString()).div(new Decimal(10).pow(amount.decimals)).mul(amount.usd);
}

function sum(amounts: readonly ValuedAmount[]): Decimal | null {
  let total = new Decimal(0);
  for (const amount of amounts) {
    const value = usdOf(amount);
    if (value === null) return null;
    total = total.add(value);
  }
  return total;
}

/** "$392", "$3.92", "$0.05" — whole dollars from $100 up, cents below. */
function formatUsd(value: number): string {
  if (value >= 100) return `$${Math.round(value).toLocaleString("en-US")}`;
  return `$${value.toFixed(2)}`;
}

export function addValueTooLowMessage(values: { inputUsd: number; depositUsd: number; bufferUsd: number }): string {
  const leftover = values.bufferUsd >= 0.01 ? ` (plus about ${formatUsd(values.bufferUsd)} left in your wallet)` : "";
  return `Only about ${formatUsd(values.depositUsd)} of your ${formatUsd(values.inputUsd)} would go into this position${leftover}, ` +
    "because the swap price for this amount is too far from the market price. Nothing was sent. Try a smaller amount.";
}

export function assessAddValue(check: AddValueInput): AddValueResult {
  const inputUsd = usdOf(check.input);
  const depositUsd = sum(check.deposit);
  const bufferUsd = sum(check.buffer);
  if (inputUsd === null || depositUsd === null || bufferUsd === null || inputUsd.lte(0)) {
    return { kind: "unpriced", message: check.narrowRange ? ADD_VALUE_UNPRICED_NARROW_MESSAGE : ADD_VALUE_UNPRICED_MESSAGE };
  }
  const deliveredUsd = depositUsd.add(bufferUsd);
  if (deliveredUsd.mul(10_000).gte(inputUsd.mul(check.floorBps))) return { kind: "ok", inputUsd: inputUsd.toNumber(), deliveredUsd: deliveredUsd.toNumber() };
  const values = { inputUsd: inputUsd.toNumber(), depositUsd: depositUsd.toNumber(), bufferUsd: bufferUsd.toNumber() };
  return { kind: "too-low", ...values, message: addValueTooLowMessage(values) };
}

export const ADD_VALUE_TOO_LOW_CODE = "add_value_too_low";
/** Separate from too-low so logs and alerts tell a bad swap apart from a price feed outage. */
export const ADD_VALUE_UNPRICED_CODE = "add_value_unpriced";

const ADD_VALUE_BLOCK_CODES = { "too-low": ADD_VALUE_TOO_LOW_CODE, unpriced: ADD_VALUE_UNPRICED_CODE } as const;
type AddValueBlockKind = keyof typeof ADD_VALUE_BLOCK_CODES;

/** Thrown before an Add is built or signed when `assessAddValue` blocks it. The message is the plain reason. */
export class AddValueBlockedError extends Error {
  readonly code: (typeof ADD_VALUE_BLOCK_CODES)[AddValueBlockKind];
  constructor(kind: AddValueBlockKind, message: string) {
    super(message);
    this.name = "AddValueBlockedError";
    this.code = ADD_VALUE_BLOCK_CODES[kind];
  }
}

import type { Address, Hex } from "viem";
import { UNIV4_RHC } from "./constants";

/**
 * Constants for building a SPCX/SPCXon open-position transaction (design.md v2.2 §3.10, PM decisions 2026-10-29).
 * Code constants, not env vars: changing any of them is a reviewed code change.
 */

/** Universal Router pin: the ONLY router a plan may call. The runtime codehash is checked on every build. */
export const PINNED_UNIVERSAL_ROUTER = {
  address: UNIV4_RHC.universalRouter,
  version: "2.1.2",
  runtimeCodeHash: "0x76b92a5bba2dd32019a64eb421f1750e78c6ba044dbfa6840b722eb5ac63d296" as Hex,
} as const;

/**
 * The fee recipient (TAKE_PORTION) is NOT a constant: it comes from the server-only env var `RHC_UNIV4_FEE_WALLET`
 * (see `fee-recipient.ts`) and is passed to the builder, guard and simulation checks explicitly.
 */

/** SoFinance fee: TAKE_PORTION on the swap OUTPUT only (never on the unswapped side). */
export const OPEN_FEE_BPS = 10n;
/** Swap slippage (minOut) in bps — PM default 2026-10-29. */
export const SLIPPAGE_BPS = 5n;
/**
 * Exit (PR7) min-out: amount0Min/amount1Min = simulated amounts × (1 − EXIT_SLIPPAGE_BPS / 1e4). 50 bps is the value
 * used for the PR6 live exit (design §6.2). No SoFinance fee on exit (design §3.8).
 */
export const EXIT_SLIPPAGE_BPS = 50n;
/** priceTol = max(PRICE_TOL_FLOOR_BPS, PRICE_TOL_HALFWIDTH_PCT % of the range half-width in bps). */
export const PRICE_TOL_FLOOR_BPS = 0.2;
export const PRICE_TOL_HALFWIDTH_PCT = 1;
/** PM decision 2026-10-29: ranges narrower than ±10 ticks (tickUpper − tickLower < 20) are rejected. */
export const MIN_RANGE_HALF_WIDTH_TICKS = 10;
export const MIN_RANGE_WIDTH_TICKS = 2 * MIN_RANGE_HALF_WIDTH_TICKS;
/** PM decision 2026-10-29: on revert, re-quote automatically at most once, then show an error. */
export const MAX_REQUOTE_RETRIES = 1;
/** gasLimit = estimate × (1 + GAS_BUFFER_BPS / 1e4). */
export const GAS_BUFFER_BPS = 2500n;
/** Permit2 PermitSingle windows (seconds). */
export const PERMIT_EXPIRATION_SECONDS = 30 * 60;
export const PERMIT_SIG_DEADLINE_SECONDS = 10 * 60;
/** UR / POSM execution deadline (seconds). */
export const EXECUTE_DEADLINE_SECONDS = 10 * 60;
/** StateView tick-bitmap words scanned each side of the current word (±4 × 256 ticks at spacing 1). */
export const TICK_SCAN_WORDS = 4;

/** PM decision 2026-10-29: wording shown when the one automatic re-quote needs the user's confirmation. */
export const REQUOTE_CONFIRM_MESSAGE = {
  zh: "價格剛變動，已重新報價，請再確認一次",
  en: "Price just moved. We re-quoted it, please confirm once more.",
} as const;

export const MAX_UINT160 = (1n << 160n) - 1n;
export const MAX_UINT256 = (1n << 256n) - 1n;
/** UR ActionConstants.ADDRESS_THIS. */
export const UR_ADDRESS_THIS: Address = "0x0000000000000000000000000000000000000002";
/** v4 ActionConstants.OPEN_DELTA (amountIn = 0 → use the full open credit). */
export const OPEN_DELTA = 0n;

/**
 * Open preview note for the part of the deposit that does not fit the range (PM, 2026-10-29). `{x}` = percent of
 * the deposit refunded in the same transaction, from the simulation's actual refund transfers.
 */
export const LEFTOVER_REFUND_TEMPLATE = Object.freeze({
  zh: "約 {x}% 無法放進區間，會在同一筆交易退回你的錢包",
  en: "About {x}% won't fit in the range and is returned to your wallet in the same transaction",
});

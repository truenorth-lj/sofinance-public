import "@/lib/engine-host";
import "server-only";

import {
  JUPITER_MAX_ACCOUNTS, directRouteConstraints, isTxOversizeError, type JupiterRouteConstraints,
} from "@sofinance/engine/jupiter-route-retry";
import { JupiterHttpError } from "@sofinance/engine/jupiter/errors";
import { SELECTED_RATE_LIMIT_RETRY_MS } from "@sofinance/engine/jupiter/client";
import { SOLANA_TX_SIZE_LIMIT } from "@sofinance/engine/transaction-limits";
import { sleep } from "@sofinance/engine/rpc/retry";
import { isJupiterNoRouteError, JupiterNoRouteError } from "@sofinance/engine/swap/jupiter";

/** AMMs whose routes tend to blow the 1,232-byte v0 packet once Raydium add-liquidity is appended. */
export const HIGH_ACCOUNT_DEXES = "OpenBook,OpenBook V2,Phoenix,GooseFX,Invariant,Cropper";

/** Quote-bundle attempts per selected preflight, including the first compact try. */
export const SELECTED_PREFLIGHT_STRATEGY_BUDGET = 4;

export type SelectedRouteAttempt = {
  skipProbe: boolean;
};

function constraintsKey(constraints: JupiterRouteConstraints) {
  return [
    constraints.maxAccounts,
    constraints.onlyDirectRoutes === true ? "d" : "",
    constraints.dexes ?? "",
    constraints.excludeDexes ?? "",
  ].join(":");
}

function isJupiterRateLimitError(error: unknown): error is JupiterHttpError {
  return error instanceof JupiterHttpError && error.status === 429;
}

function rateLimitWaitMs(error: JupiterHttpError) {
  return Math.min(error.retryAfterMs ?? SELECTED_RATE_LIMIT_RETRY_MS, SELECTED_RATE_LIMIT_RETRY_MS);
}

/** Serialized size from a selected oversize error, when the builder reported it. */
export function txOversizeBytes(error: unknown): number | null {
  if (!isTxOversizeError(error)) return null;
  const message = error instanceof Error ? error.message : String(error);
  const match = /transaction (\d+) bytes/i.exec(message);
  return match ? Number(match[1]) : null;
}

export function txOvershootBytes(error: unknown): number | null {
  const bytes = txOversizeBytes(error);
  return bytes !== null && bytes > SOLANA_TX_SIZE_LIMIT ? bytes - SOLANA_TX_SIZE_LIMIT : null;
}

/**
 * Extra compact quotes after a maxAccounts tier produced an oversize v0 tx.
 * Ordered by likelihood of fitting given the measured overshoot. Production
 * fee+tip overhead is ~115–160 bytes; high-account DEX filters at compact
 * usually beat 20-account-only hops for SPCX→HOOD-class pairs.
 */
export function selectedOversizeFollowups(
  oversizeAt: number,
  oversizeBytes?: number | null,
): JupiterRouteConstraints[] {
  const compact = Math.min(oversizeAt, JUPITER_MAX_ACCOUNTS.compact);
  const overshoot = oversizeBytes !== null && oversizeBytes !== undefined && oversizeBytes > SOLANA_TX_SIZE_LIMIT
    ? oversizeBytes - SOLANA_TX_SIZE_LIMIT
    : 80;
  const excludeCompact: JupiterRouteConstraints = { maxAccounts: compact, excludeDexes: HIGH_ACCOUNT_DEXES };
  const direct = directRouteConstraints();
  const excludeDirect: JupiterRouteConstraints = { ...directRouteConstraints(), excludeDexes: HIGH_ACCOUNT_DEXES };
  if (overshoot <= 48) {
    return [
      excludeCompact,
      ...(oversizeAt > compact ? [{ maxAccounts: compact } as JupiterRouteConstraints] : []),
      direct,
    ];
  }
  if (overshoot <= 160) {
    return [excludeCompact, direct, excludeDirect];
  }
  return [direct, excludeCompact, excludeDirect];
}

/**
 * Compact first (same-pool / simple hops). Widen maxAccounts when Jupiter has
 * no route; tighten only when the assembled v0 transaction exceeds 1,232 bytes.
 * After oversize, pick a short follow-up list ordered by overshoot. Cap total
 * quote-bundle attempts so a preflight cannot exhaust Jupiter's rate window.
 */
export async function withSelectedRouteRetries<T>(
  fn: (constraints: JupiterRouteConstraints, attempt: SelectedRouteAttempt) => Promise<T>,
): Promise<T> {
  const widen: JupiterRouteConstraints[] = [
    { maxAccounts: JUPITER_MAX_ACCOUNTS.compact },
    { maxAccounts: JUPITER_MAX_ACCOUNTS.medium },
    { maxAccounts: JUPITER_MAX_ACCOUNTS.wide },
  ];

  let last: unknown;
  let sawNoRoute = false;
  let oversizeAt: number | undefined;
  let oversizeBytes: number | null = null;
  let retriedRateLimit = false;
  const seen = new Set<string>();
  let used = 0;

  const run = async (constraints: JupiterRouteConstraints, skipProbe: boolean): Promise<T> => {
    used += 1;
    const attempt = { skipProbe };
    try {
      return await fn(constraints, attempt);
    } catch (error) {
      if (isJupiterRateLimitError(error) && !retriedRateLimit) {
        retriedRateLimit = true;
        await sleep(rateLimitWaitMs(error));
        return await fn(constraints, attempt);
      }
      throw error;
    }
  };

  for (const attempt of widen) {
    if (used >= SELECTED_PREFLIGHT_STRATEGY_BUDGET) break;
    seen.add(constraintsKey(attempt));
    try {
      return await run(attempt, false);
    } catch (error) {
      last = error;
      if (isTxOversizeError(error)) {
        oversizeAt = attempt.maxAccounts;
        oversizeBytes = txOversizeBytes(error);
        break;
      }
      if (!isJupiterNoRouteError(error)) throw error;
      sawNoRoute = true;
    }
  }

  if (oversizeAt !== undefined) {
    for (const attempt of selectedOversizeFollowups(oversizeAt, oversizeBytes)) {
      if (used >= SELECTED_PREFLIGHT_STRATEGY_BUDGET) break;
      if (seen.has(constraintsKey(attempt))) continue;
      seen.add(constraintsKey(attempt));
      try {
        return await run(attempt, true);
      } catch (error) {
        last = error;
        if (isTxOversizeError(error)) continue;
        if (isJupiterNoRouteError(error)) {
          sawNoRoute = true;
          continue;
        }
        throw error;
      }
    }
    throw last instanceof JupiterNoRouteError ? last : new JupiterNoRouteError();
  }

  if (last === undefined) throw new JupiterNoRouteError();
  if (sawNoRoute) throw last instanceof JupiterNoRouteError ? last : new JupiterNoRouteError();
  throw last;
}

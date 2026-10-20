import "@/lib/engine-host";
import "server-only";

import {
  JUPITER_MAX_ACCOUNTS, directRouteConstraints, isTxOversizeError, type JupiterRouteConstraints,
} from "@sofinance/engine/jupiter-route-retry";
import { JupiterHttpError } from "@sofinance/engine/jupiter/errors";
import { SELECTED_RATE_LIMIT_RETRY_MS } from "@sofinance/engine/jupiter/client";
import { sleep } from "@sofinance/engine/rpc/retry";
import { isJupiterNoRouteError, JupiterNoRouteError } from "@sofinance/engine/swap/jupiter";

/** AMMs whose routes tend to blow the 1,232-byte v0 packet once Raydium add-liquidity is appended. */
export const HIGH_ACCOUNT_DEXES = "OpenBook,OpenBook V2,Phoenix,GooseFX,Invariant,Cropper";

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

/** Extra compact quotes after every maxAccounts tier produced an oversize v0 tx. */
export function selectedOversizeFollowups(oversizeAt: number): JupiterRouteConstraints[] {
  const compact = Math.min(oversizeAt, JUPITER_MAX_ACCOUNTS.compact);
  const followups: JupiterRouteConstraints[] = [];
  if (oversizeAt > JUPITER_MAX_ACCOUNTS.medium) followups.push({ maxAccounts: JUPITER_MAX_ACCOUNTS.medium });
  if (oversizeAt > JUPITER_MAX_ACCOUNTS.compact) followups.push({ maxAccounts: JUPITER_MAX_ACCOUNTS.compact });
  if (oversizeAt >= JUPITER_MAX_ACCOUNTS.medium) {
    followups.push({ maxAccounts: JUPITER_MAX_ACCOUNTS.medium, excludeDexes: HIGH_ACCOUNT_DEXES });
  }
  followups.push(
    { maxAccounts: compact, onlyDirectRoutes: true },
    { maxAccounts: compact, excludeDexes: HIGH_ACCOUNT_DEXES },
    { maxAccounts: compact, onlyDirectRoutes: true, excludeDexes: HIGH_ACCOUNT_DEXES },
    directRouteConstraints(),
    { ...directRouteConstraints(), excludeDexes: HIGH_ACCOUNT_DEXES },
  );
  return followups;
}

/**
 * Compact first (same-pool / simple hops). Widen maxAccounts when Jupiter has
 * no route; tighten only when the assembled v0 transaction exceeds 1,232 bytes.
 * After oversize, requote once and try direct / DEX-filtered compact routes.
 */
export async function withSelectedRouteRetries<T>(
  fn: (constraints: JupiterRouteConstraints) => Promise<T>,
): Promise<T> {
  const widen: JupiterRouteConstraints[] = [
    { maxAccounts: JUPITER_MAX_ACCOUNTS.compact },
    { maxAccounts: JUPITER_MAX_ACCOUNTS.medium },
    { maxAccounts: JUPITER_MAX_ACCOUNTS.wide },
  ];

  let last: unknown;
  let sawNoRoute = false;
  let oversizeAt: number | undefined;
  let oversizeConstraints: JupiterRouteConstraints | undefined;
  let retriedRateLimit = false;
  const seen = new Set<string>();

  const run = async (constraints: JupiterRouteConstraints): Promise<T> => {
    try {
      return await fn(constraints);
    } catch (error) {
      if (isJupiterRateLimitError(error) && !retriedRateLimit) {
        retriedRateLimit = true;
        await sleep(rateLimitWaitMs(error));
        return await fn(constraints);
      }
      throw error;
    }
  };

  for (const attempt of widen) {
    seen.add(constraintsKey(attempt));
    try {
      return await run(attempt);
    } catch (error) {
      last = error;
      if (isTxOversizeError(error)) {
        oversizeAt = attempt.maxAccounts;
        oversizeConstraints = attempt;
        break;
      }
      if (!isJupiterNoRouteError(error)) throw error;
      sawNoRoute = true;
    }
  }

  if (oversizeAt !== undefined && oversizeConstraints) {
    try {
      return await run(oversizeConstraints);
    } catch (error) {
      last = error;
      if (isJupiterNoRouteError(error)) sawNoRoute = true;
      else if (!isTxOversizeError(error)) throw error;
    }

    for (const attempt of selectedOversizeFollowups(oversizeAt)) {
      if (seen.has(constraintsKey(attempt))) continue;
      seen.add(constraintsKey(attempt));
      try {
        return await run(attempt);
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
  }

  if (last === undefined) throw new JupiterNoRouteError();
  if (sawNoRoute) throw last instanceof JupiterNoRouteError ? last : new JupiterNoRouteError();
  throw last;
}

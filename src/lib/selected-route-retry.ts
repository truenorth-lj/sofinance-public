import "@/lib/engine-host";
import "server-only";

import {
  JUPITER_MAX_ACCOUNTS, directRouteConstraints, isTxOversizeError, type JupiterRouteConstraints,
} from "@sofinance/engine/jupiter-route-retry";
import { isJupiterNoRouteError, JupiterNoRouteError } from "@sofinance/engine/swap/jupiter";

function constraintsKey(constraints: JupiterRouteConstraints) {
  return `${constraints.maxAccounts}:${constraints.onlyDirectRoutes === true}`;
}

/**
 * Compact first (same-pool / simple hops). Widen maxAccounts when Jupiter has
 * no route; tighten only when the assembled v0 transaction exceeds 1,232 bytes.
 */
export async function withSelectedRouteRetries<T>(
  fn: (constraints: JupiterRouteConstraints) => Promise<T>,
): Promise<T> {
  const widen: JupiterRouteConstraints[] = [
    { maxAccounts: JUPITER_MAX_ACCOUNTS.compact },
    { maxAccounts: JUPITER_MAX_ACCOUNTS.medium },
    { maxAccounts: JUPITER_MAX_ACCOUNTS.wide },
  ];
  const tighten: JupiterRouteConstraints[] = [
    { maxAccounts: JUPITER_MAX_ACCOUNTS.medium },
    { maxAccounts: JUPITER_MAX_ACCOUNTS.compact },
    directRouteConstraints(),
  ];

  let last: unknown;
  let sawNoRoute = false;
  let oversizeAt: number | undefined;
  const seen = new Set<string>();

  for (const attempt of widen) {
    seen.add(constraintsKey(attempt));
    try {
      return await fn(attempt);
    } catch (error) {
      last = error;
      if (isTxOversizeError(error)) {
        oversizeAt = attempt.maxAccounts;
        break;
      }
      if (!isJupiterNoRouteError(error)) throw error;
      sawNoRoute = true;
    }
  }

  if (oversizeAt !== undefined) {
    for (const attempt of tighten) {
      if (attempt.maxAccounts >= oversizeAt || seen.has(constraintsKey(attempt))) continue;
      seen.add(constraintsKey(attempt));
      try {
        return await fn(attempt);
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

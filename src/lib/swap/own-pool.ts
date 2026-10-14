import "server-only";
import { JupiterHttpError } from "../jupiter";
import { JUPITER_MAX_ACCOUNTS, type JupiterRouteConstraints } from "../jupiter-route-retry";
import { JupiterNoRouteError, type QuoteRoute } from "./jupiter";

/** Jupiter DEX label for Raydium concentrated-liquidity pools. */
export const RAYDIUM_CLMM_DEX = "Raydium CLMM";

export type OwnPool = { poolId: string; mintA: string; mintB: string };

export function isPoolTokenPair(pool: OwnPool, inputMint: string, outputMint: string) {
  return (inputMint === pool.mintA && outputMint === pool.mintB)
    || (inputMint === pool.mintB && outputMint === pool.mintA);
}

export function ownPoolConstraints(constraints?: JupiterRouteConstraints): JupiterRouteConstraints {
  return { maxAccounts: Math.min(constraints?.maxAccounts ?? JUPITER_MAX_ACCOUNTS.direct, JUPITER_MAX_ACCOUNTS.direct), onlyDirectRoutes: true, dexes: RAYDIUM_CLMM_DEX };
}

export function assertOwnPoolRoute(route: QuoteRoute, poolId: string) {
  if (route.routePlan.length !== 1 || route.routePlan[0]?.bps !== 10_000 || route.routePlan[0].swapInfo.ammKey !== poolId)
    throw new Error("Jupiter route must use only the original pool");
}

/** Jupiter filters by DEX, not pool ID. A different CLMM is not an own-pool route. */
export async function preferOwnPoolRoute<T extends QuoteRoute>(
  poolId: string, request: (constraints?: JupiterRouteConstraints) => Promise<T>, constraints?: JupiterRouteConstraints,
): Promise<T> {
  let route: T | undefined;
  try {
    route = await request(ownPoolConstraints(constraints));
  } catch (error) {
    if (!(error instanceof JupiterNoRouteError) && !(error instanceof JupiterHttpError && error.status === 400
      && /^no routes found$/i.test(error.bodyError ?? ""))) throw error;
  }
  if (route) {
    // Reject the candidate before accepting any of its instructions.
    try { assertOwnPoolRoute(route, poolId); } catch { return request(constraints); }
    return route;
  }
  return request(constraints);
}

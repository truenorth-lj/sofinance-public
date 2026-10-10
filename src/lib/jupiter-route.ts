import "server-only";

import { jupiterRequest, JupiterHttpError, JUPITER_BUILD_PATH } from "./jupiter";
import { MAX_PRICE_IMPACT_BPS, SLIPPAGE_BPS } from "./ids";
import { acceptableReportedPriceImpact } from "./quote-guards";
import type { JupiterRouteConstraints } from "./jupiter-route-retry";

export type ApiInstruction = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
export type BuildRoute = {
  inputMint: string; outputMint: string; inAmount: string; outAmount: string; otherAmountThreshold: string;
  swapMode: string; slippageBps: number; priceImpactPct?: string;
  routePlan: { percent: number; bps: number; swapInfo: { ammKey: string; inputMint: string; outputMint: string; inAmount: string; outAmount: string } }[];
  computeBudgetInstructions: ApiInstruction[]; setupInstructions: ApiInstruction[]; swapInstruction: ApiInstruction;
  cleanupInstruction: ApiInstruction | null; otherInstructions: ApiInstruction[]; tipInstruction: ApiInstruction | null;
  addressesByLookupTableAddress: Record<string, string[]> | null;
};

export class JupiterNoRouteError extends Error {
  constructor() { super("Jupiter has no available route for this account budget"); }
}

function resolveConstraints(constraints?: JupiterRouteConstraints | number): JupiterRouteConstraints {
  if (typeof constraints === "number") return { maxAccounts: constraints };
  return constraints ?? { maxAccounts: 48 };
}

export async function buildRoute(
  wallet: string,
  inputMint: string,
  outputMint: string,
  amount: bigint,
  wrapAndUnwrapSol?: boolean,
  constraints: JupiterRouteConstraints | number = { maxAccounts: 48 },
): Promise<BuildRoute> {
  const key = process.env.JUPITER_API_KEY;
  if (!key && process.env.E2E_KEYLESS_JUPITER !== "1") throw new Error("Server-side JUPITER_API_KEY not set, cannot obtain real-time quotes");
  if (amount <= 0n) throw new Error("Route amount must be greater than zero");
  const resolved = resolveConstraints(constraints);
  if (!Number.isInteger(resolved.maxAccounts) || resolved.maxAccounts < 1 || resolved.maxAccounts > 64) {
    throw new Error("Invalid Jupiter route account budget");
  }
  const query = {
    inputMint, outputMint, amount: amount.toString(), taker: wallet,
    slippageBps: SLIPPAGE_BPS, maxAccounts: resolved.maxAccounts,
    ...(resolved.onlyDirectRoutes ? { onlyDirectRoutes: true } : {}),
    ...(wrapAndUnwrapSol !== undefined ? { wrapAndUnwrapSol } : {}),
  };
  let route: BuildRoute;
  try {
    route = await jupiterRequest<BuildRoute>({
      path: JUPITER_BUILD_PATH,
      query,
      apiKey: key,
      cacheKey: null,
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    if (error instanceof JupiterHttpError && error.status === 400 && /^no routes found$/i.test(error.bodyError ?? "")) {
      throw new JupiterNoRouteError();
    }
    const status = error instanceof JupiterHttpError ? error.status : "error";
    throw new Error(`Jupiter /build has no available routes (HTTP ${status})`);
  }
  if (route.inputMint !== inputMint || route.outputMint !== outputMint || BigInt(route.inAmount) !== amount || route.swapMode !== "ExactIn" || route.slippageBps !== SLIPPAGE_BPS || BigInt(route.otherAmountThreshold) <= 0n || BigInt(route.otherAmountThreshold) > BigInt(route.outAmount) || !route.swapInstruction || !Array.isArray(route.routePlan) || route.routePlan.length === 0) throw new Error("Jupiter route content does not match request");
  if (!acceptableReportedPriceImpact(route.priceImpactPct, MAX_PRICE_IMPACT_BPS)) throw new Error(`Swap price impact invalid or exceeds ${MAX_PRICE_IMPACT_BPS / 100}% limit`);
  if (route.tipInstruction) throw new Error("Route contains unexpected SOL tip");
  return route;
}

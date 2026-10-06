import "server-only";

import { MAX_PRICE_IMPACT_BPS, SLIPPAGE_BPS } from "./ids";
import { acceptableReportedPriceImpact } from "./quote-guards";

export type ApiInstruction = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
export type BuildRoute = {
  inputMint: string; outputMint: string; inAmount: string; outAmount: string; otherAmountThreshold: string;
  swapMode: string; slippageBps: number; priceImpactPct?: string;
  routePlan: { percent: number; bps: number; swapInfo: { ammKey: string; inputMint: string; outputMint: string; inAmount: string; outAmount: string } }[];
  computeBudgetInstructions: ApiInstruction[]; setupInstructions: ApiInstruction[]; swapInstruction: ApiInstruction;
  cleanupInstruction: ApiInstruction | null; otherInstructions: ApiInstruction[]; tipInstruction: ApiInstruction | null;
  addressesByLookupTableAddress: Record<string, string[]> | null;
};

let nextJupiterRequest = 0;
let requestQueue: Promise<unknown> = Promise.resolve();
function pacedFetch(url: URL, key: string) {
  const result = requestQueue.then(async () => {
    const wait = Math.max(0, nextJupiterRequest - Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    nextJupiterRequest = Date.now() + Number(process.env.E2E_JUP_PACE_MS || 1_100); // Jupiter free tier is one request per second.
    return fetch(url, { headers: process.env.E2E_KEYLESS_JUPITER === "1" ? {} : { "x-api-key": key }, cache: "no-store", signal: AbortSignal.timeout(12_000) });
  });
  requestQueue = result.catch(() => undefined);
  return result;
}

export async function buildRoute(wallet: string, inputMint: string, outputMint: string, amount: bigint, wrapAndUnwrapSol?: boolean): Promise<BuildRoute> {
  const key = process.env.JUPITER_API_KEY;
  if (!key) throw new Error("Server-side JUPITER_API_KEY not set, cannot obtain real-time quotes");
  if (amount <= 0n) throw new Error("Route amount must be greater than zero");
  const url = new URL("https://api.jup.ag/swap/v2/build");
  url.search = new URLSearchParams({ inputMint, outputMint, amount: amount.toString(), taker: wallet, slippageBps: String(SLIPPAGE_BPS), maxAccounts: "48" }).toString();
  if (wrapAndUnwrapSol !== undefined) url.searchParams.set("wrapAndUnwrapSol", String(wrapAndUnwrapSol));
  const response = await pacedFetch(url, key);
  if (!response.ok) throw new Error(`Jupiter /build has no available routes (HTTP ${response.status})`);
  const route = await response.json() as BuildRoute;
  if (route.inputMint !== inputMint || route.outputMint !== outputMint || BigInt(route.inAmount) !== amount || route.swapMode !== "ExactIn" || route.slippageBps !== SLIPPAGE_BPS || BigInt(route.otherAmountThreshold) <= 0n || BigInt(route.otherAmountThreshold) > BigInt(route.outAmount) || !route.swapInstruction || !Array.isArray(route.routePlan) || route.routePlan.length === 0) throw new Error("Jupiter route content does not match request");
  if (!acceptableReportedPriceImpact(route.priceImpactPct, MAX_PRICE_IMPACT_BPS)) throw new Error(`Swap price impact invalid or exceeds ${MAX_PRICE_IMPACT_BPS / 100}% limit`);
  if (route.tipInstruction) throw new Error("Route contains unexpected SOL tip");
  return route;
}

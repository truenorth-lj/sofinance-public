import "server-only";

import { JupiterHttpError } from "../jupiter";
import { MAX_PRICE_IMPACT_BPS, SLIPPAGE_BPS } from "../ids";
import { acceptableReportedPriceImpact } from "../quote-guards";
import type { JupiterRouteConstraints } from "../jupiter-route-retry";
import { getJupiterApiKey } from "../config/server-env";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { USDC_MINT } from "../ids";
import { feeAccountSetup } from "./collection";
import { rpcConnection } from "../rpc";
import { assertPlatformFeeQuote, readSwapFeeConfig, swapFeeRecipientAta } from "./fee";
import { jupiterQuote, jupiterSwapInstructions } from "./client";
import type { JupiterRetryBudget } from "../jupiter/client";

export type ApiInstruction = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
export type BuildRoute = {
  platformFee?: { amount: string; feeBps: number } | null;
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
  signal?: AbortSignal,
  budget?: JupiterRetryBudget,
  destinationTokenAccount?: string,
  platformFeeBps = 0,
): Promise<BuildRoute> {
  const key = getJupiterApiKey();
  if (!key && process.env.E2E_KEYLESS_JUPITER !== "1") throw new Error("Server-side JUPITER_API_KEY not set, cannot obtain real-time quotes");
  if (amount <= 0n) throw new Error("Route amount must be greater than zero");
  const resolved = resolveConstraints(constraints);
  if (!Number.isInteger(resolved.maxAccounts) || resolved.maxAccounts < 1 || resolved.maxAccounts > 64) {
    throw new Error("Invalid Jupiter route account budget");
  }
  let route: BuildRoute;
  try {
    const quote = await quoteRoute(inputMint, outputMint, amount, resolved, signal, budget, platformFeeBps);
    const instructions = await jupiterSwapInstructions<BuildRoute & { addressLookupTableAddresses: string[] }>({
      ...(platformFeeBps ? { feeAccount: swapFeeRecipientAta(readSwapFeeConfig().wallet!, new PublicKey(USDC_MINT), TOKEN_PROGRAM_ID).toBase58() } : {}),
      destinationTokenAccount, userPublicKey: wallet, quoteResponse: quote, wrapAndUnwrapSol: wrapAndUnwrapSol ?? false,
      useSharedAccounts: false, dynamicComputeUnitLimit: false, prioritizationFeeLamports: 0,
    }, { apiKey: key, budget,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000),
    });
    route = { ...quote, ...instructions,
      otherInstructions: instructions.otherInstructions ?? [], tipInstruction: instructions.tipInstruction ?? null,
      addressesByLookupTableAddress: Object.fromEntries((instructions.addressLookupTableAddresses ?? []).map(key => [key, []])) };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof JupiterHttpError && error.status === 400 && /^no routes found$/i.test(error.bodyError ?? "")) {
      throw new JupiterNoRouteError();
    }
    throw error;
  }
  assertPlatformFeeQuote(route, platformFeeBps);
  if (route.inputMint !== inputMint || route.outputMint !== outputMint || BigInt(route.inAmount) !== amount || route.swapMode !== "ExactIn" || route.slippageBps !== SLIPPAGE_BPS || BigInt(route.otherAmountThreshold) <= 0n || BigInt(route.otherAmountThreshold) > BigInt(route.outAmount) || !route.swapInstruction || !Array.isArray(route.routePlan) || route.routePlan.length === 0) throw new Error("Jupiter route content does not match request");
  if (!acceptableReportedPriceImpact(route.priceImpactPct, MAX_PRICE_IMPACT_BPS)) throw new Error(`Swap price impact invalid or exceeds ${MAX_PRICE_IMPACT_BPS / 100}% limit`);
  if (route.tipInstruction) throw new Error("Route contains unexpected SOL tip");
  if (platformFeeBps) {
    const setup = await feeAccountSetup(rpcConnection(), new PublicKey(wallet), readSwapFeeConfig().wallet!);
    route.setupInstructions.unshift(...setup.instructions.map(ix => ({ programId: ix.programId.toBase58(),
      accounts: ix.keys.map(key => ({ pubkey: key.pubkey.toBase58(), isSigner: key.isSigner, isWritable: key.isWritable })), data: ix.data.toString("base64") })));
  }
  return { ...route, routePlan: route.routePlan.map(hop => ({ ...hop, bps: hop.bps ?? hop.percent * 100 })) };
}

export type QuoteRoute = Pick<BuildRoute, "platformFee" | "inputMint" | "outputMint" | "inAmount" | "outAmount" | "otherAmountThreshold" | "swapMode" | "slippageBps" | "priceImpactPct" | "routePlan">;

/** Lightweight, uncached execution estimate; no transaction instructions. */
export async function quoteRoute(inputMint: string, outputMint: string, amount: bigint,
  constraints: JupiterRouteConstraints = { maxAccounts: 24 }, signal?: AbortSignal,
  budget?: JupiterRetryBudget, platformFeeBps = 0): Promise<QuoteRoute> {
  const key = getJupiterApiKey();
  if (!key && process.env.E2E_KEYLESS_JUPITER !== "1") throw new Error("Server-side JUPITER_API_KEY not set, cannot obtain real-time quotes");
  const route = await jupiterQuote<QuoteRoute>({ inputMint, outputMint, amount: amount.toString(),
    platformFeeBps, dexes: constraints.dexes, slippageBps: SLIPPAGE_BPS, maxAccounts: constraints.maxAccounts, onlyDirectRoutes: constraints.onlyDirectRoutes,
    apiKey: key, cacheKey: null, signal, budget });
  assertPlatformFeeQuote(route, platformFeeBps);
  if (route.inputMint !== inputMint || route.outputMint !== outputMint || BigInt(route.inAmount) !== amount ||
    route.swapMode !== "ExactIn" || route.slippageBps !== SLIPPAGE_BPS ||
    BigInt(route.otherAmountThreshold) <= 0n || BigInt(route.otherAmountThreshold) > BigInt(route.outAmount) ||
    !Array.isArray(route.routePlan) || route.routePlan.length === 0) throw new Error("Jupiter route content does not match request");
  if (!acceptableReportedPriceImpact(route.priceImpactPct, MAX_PRICE_IMPACT_BPS)) throw new Error(`Swap price impact invalid or exceeds ${MAX_PRICE_IMPACT_BPS / 100}% limit`);
  return { ...route, routePlan: route.routePlan.map((hop) => ({ ...hop, bps: hop.bps ?? hop.percent * 100 })) };
}

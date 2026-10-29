import { engineEnv } from "../host";
import { JUPITER_NO_ROUTE_CODE, isJupiterNoRouteHttp } from "../jupiter/errors";
import { MAX_PRICE_IMPACT_BPS, SLIPPAGE_BPS } from "../ids";
import { acceptableReportedPriceImpact } from "../quote-guards";
import { JUPITER_MAX_ACCOUNTS, type JupiterRouteConstraints } from "../jupiter-route-retry";
import { getJupiterApiKey } from "../config/server-env";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { USDC_MINT } from "../ids";
import { feeAccountSetup, requireInputFeeAccount } from "./collection";
import { rpcConnection } from "../rpc";
import { assertPlatformFeeQuote, readSwapFeeConfig, swapFeeRecipientAta } from "./fee";
import { jupiterQuote, jupiterSwapInstructions } from "./client";
import { jupiterRelayActive } from "../jupiter/client";
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
  readonly code = JUPITER_NO_ROUTE_CODE;
  constructor() {
    super("Jupiter has no available route for this account budget");
    this.name = "JupiterNoRouteError";
  }
}

export function isJupiterNoRouteError(error: unknown): boolean {
  return error instanceof JupiterNoRouteError || isJupiterNoRouteHttp(error);
}

function rethrowMappedJupiterError(error: unknown, signal?: AbortSignal): never {
  if (signal?.aborted) throw signal.reason;
  if (isJupiterNoRouteError(error)) {
    throw error instanceof JupiterNoRouteError ? error : new JupiterNoRouteError();
  }
  throw error;
}

function resolveConstraints(constraints?: JupiterRouteConstraints | number): JupiterRouteConstraints {
  if (typeof constraints === "number") return { maxAccounts: constraints };
  return constraints ?? { maxAccounts: JUPITER_MAX_ACCOUNTS.wide };
}

export async function buildRoute(
  wallet: string,
  inputMint: string,
  outputMint: string,
  amount: bigint,
  wrapAndUnwrapSol?: boolean,
  constraints: JupiterRouteConstraints | number = { maxAccounts: JUPITER_MAX_ACCOUNTS.wide },
  signal?: AbortSignal,
  budget?: JupiterRetryBudget,
  destinationTokenAccount?: string,
  platformFeeBps = 0,
  maxPriceImpactBps = MAX_PRICE_IMPACT_BPS,
  quoted?: QuoteRoute,
  /** Mint of the fee wallet ATA that receives `platformFeeBps`. USDC output
   * (default; withdraw) is created in-transaction when missing. When it equals
   * `inputMint` (deposits: SOL, USDC, stock tokens) the fee is charged in the
   * input mint into the operator's pre-created ATA and fails closed when it is
   * missing. */
  feeMint: string = USDC_MINT,
): Promise<BuildRoute> {
  const key = getJupiterApiKey();
  if (!key && !jupiterRelayActive() && engineEnv().E2E_KEYLESS_JUPITER !== "1") throw new Error("Server-side JUPITER_API_KEY not set, cannot obtain real-time quotes");
  if (amount <= 0n) throw new Error("Route amount must be greater than zero");
  const resolved = resolveConstraints(constraints);
  if (!Number.isInteger(resolved.maxAccounts) || resolved.maxAccounts < 1 || resolved.maxAccounts > 64) {
    throw new Error("Invalid Jupiter route account budget");
  }
  // Input-mint fee: deposits (SOL, USDC, stock tokens) pay 10 bps of the
  // swapped input into the fee wallet's pre-created ATA for that mint.
  const inputMintFee = Boolean(platformFeeBps) && feeMint === inputMint;
  if (platformFeeBps && !inputMintFee && feeMint !== USDC_MINT) {
    throw new Error("Unsupported protocol fee mint for this route");
  }
  const feeAccount = platformFeeBps
    ? inputMintFee
      ? (await requireInputFeeAccount(rpcConnection(), readSwapFeeConfig().wallet!, new PublicKey(inputMint))).toBase58()
      : swapFeeRecipientAta(readSwapFeeConfig().wallet!, new PublicKey(USDC_MINT), TOKEN_PROGRAM_ID).toBase58()
    : null;
  let route: BuildRoute;
  try {
    // Without a caller-supplied quote (one the caller just validated in this
    // request), the route that gets built and signed is quoted fresh.
    const quote = quoted ?? await quoteRoute(inputMint, outputMint, amount, resolved, signal, budget, platformFeeBps, maxPriceImpactBps, false);
    const instructions = await jupiterSwapInstructions<BuildRoute & { addressLookupTableAddresses: string[] }>({
      ...(feeAccount ? { feeAccount } : {}),
      destinationTokenAccount, userPublicKey: wallet, quoteResponse: quote, wrapAndUnwrapSol: wrapAndUnwrapSol ?? false,
      useSharedAccounts: false, dynamicComputeUnitLimit: false, prioritizationFeeLamports: 0,
    }, { apiKey: key, budget,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000),
    });
    route = { ...quote, ...instructions,
      otherInstructions: instructions.otherInstructions ?? [], tipInstruction: instructions.tipInstruction ?? null,
      addressesByLookupTableAddress: Object.fromEntries((instructions.addressLookupTableAddresses ?? []).map(key => [key, []])) };
  } catch (error) {
    rethrowMappedJupiterError(error, signal);
  }
  assertPlatformFeeQuote(route, platformFeeBps);
  if (route.inputMint !== inputMint || route.outputMint !== outputMint || BigInt(route.inAmount) !== amount || route.swapMode !== "ExactIn" || route.slippageBps !== SLIPPAGE_BPS || BigInt(route.otherAmountThreshold) <= 0n || BigInt(route.otherAmountThreshold) > BigInt(route.outAmount) || !route.swapInstruction || !Array.isArray(route.routePlan) || route.routePlan.length === 0) throw new Error("Jupiter route content does not match request");
  if (!acceptableReportedPriceImpact(route.priceImpactPct, maxPriceImpactBps)) throw new Error(`Swap price impact invalid or exceeds ${MAX_PRICE_IMPACT_BPS / 100}% limit`);
  if (route.tipInstruction) throw new Error("Route contains unexpected SOL tip");
  assertAllowedSwapPrograms(route);
  // Cheap sanity check (not anti-tampering): the input-mint fee must be paid by
  // the swap instruction itself into the pre-created fee account.
  if (inputMintFee && !route.swapInstruction.accounts.some(key => key.pubkey === feeAccount && key.isWritable)) {
    throw new Error("Jupiter swap does not pay the protocol fee account");
  }
  if (platformFeeBps && !inputMintFee) {
    const setup = await feeAccountSetup(rpcConnection(), new PublicKey(wallet), readSwapFeeConfig().wallet!);
    route.setupInstructions.unshift(...setup.instructions.map(ix => ({ programId: ix.programId.toBase58(),
      accounts: ix.keys.map(key => ({ pubkey: key.pubkey.toBase58(), isSigner: key.isSigner, isWritable: key.isWritable })), data: ix.data.toString("base64") })));
  }
  return { ...route, routePlan: route.routePlan.map(hop => ({ ...hop, bps: hop.bps ?? hop.percent * 100 })) };
}

/**
 * Top-level programs a Jupiter swap may invoke in our transactions. Swap-instructions
 * are client-supplied in relay mode; this guards against our own bugs and garbage
 * responses (not against fee tampering, which is out of scope by decision).
 */
export const ALLOWED_SWAP_PROGRAM_IDS: ReadonlySet<string> = new Set([
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Jupiter v6 aggregator
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated Token Account
  "ComputeBudget111111111111111111111111111111", // Compute budget
  "11111111111111111111111111111111", // System (SOL wrap transfer)
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // Raydium CLMM
]);

export function assertAllowedSwapPrograms(route: Pick<BuildRoute, "setupInstructions" | "swapInstruction" | "cleanupInstruction" | "otherInstructions"> & { computeBudgetInstructions?: { programId: string }[] }) {
  const instructions = [
    ...(route.computeBudgetInstructions ?? []), ...(route.otherInstructions ?? []), ...(route.setupInstructions ?? []),
    route.swapInstruction, ...(route.cleanupInstruction ? [route.cleanupInstruction] : []),
  ];
  for (const instruction of instructions) {
    if (!instruction || typeof instruction.programId !== "string" || !ALLOWED_SWAP_PROGRAM_IDS.has(instruction.programId)) {
      throw new Error("Jupiter swap instructions use a program outside the allowlist");
    }
  }
}

export type QuoteRoute = Pick<BuildRoute, "platformFee" | "inputMint" | "outputMint" | "inAmount" | "outAmount" | "otherAmountThreshold" | "swapMode" | "slippageBps" | "priceImpactPct" | "routePlan">;

/** Lightweight execution estimate; no transaction instructions. Briefly shared (preview cache) unless building. */
export async function quoteRoute(inputMint: string, outputMint: string, amount: bigint,
  constraints: JupiterRouteConstraints = { maxAccounts: JUPITER_MAX_ACCOUNTS.compact }, signal?: AbortSignal,
  budget?: JupiterRetryBudget, platformFeeBps = 0, maxPriceImpactBps = MAX_PRICE_IMPACT_BPS,
  previewCache = true): Promise<QuoteRoute> {
  const key = getJupiterApiKey();
  if (!key && !jupiterRelayActive() && engineEnv().E2E_KEYLESS_JUPITER !== "1") throw new Error("Server-side JUPITER_API_KEY not set, cannot obtain real-time quotes");
  try {
    const route = await jupiterQuote<QuoteRoute>({ inputMint, outputMint, amount: amount.toString(),
      platformFeeBps, dexes: constraints.dexes, excludeDexes: constraints.excludeDexes, slippageBps: SLIPPAGE_BPS, maxAccounts: constraints.maxAccounts, onlyDirectRoutes: constraints.onlyDirectRoutes,
      apiKey: key, cacheKey: null, previewCache, signal, budget });
    assertPlatformFeeQuote(route, platformFeeBps);
    if (route.inputMint !== inputMint || route.outputMint !== outputMint || BigInt(route.inAmount) !== amount ||
      route.swapMode !== "ExactIn" || route.slippageBps !== SLIPPAGE_BPS ||
      BigInt(route.otherAmountThreshold) <= 0n || BigInt(route.otherAmountThreshold) > BigInt(route.outAmount) ||
      !Array.isArray(route.routePlan) || route.routePlan.length === 0) throw new Error("Jupiter route content does not match request");
    if (!acceptableReportedPriceImpact(route.priceImpactPct, maxPriceImpactBps)) throw new Error(`Swap price impact invalid or exceeds ${MAX_PRICE_IMPACT_BPS / 100}% limit`);
    return { ...route, routePlan: route.routePlan.map((hop) => ({ ...hop, bps: hop.bps ?? hop.percent * 100 })) };
  } catch (error) {
    rethrowMappedJupiterError(error, signal);
  }
}

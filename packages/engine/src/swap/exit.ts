import { PublicKey, type Connection } from "@solana/web3.js";
import { USDC_MINT } from "../ids";
import { jupiterQuotePreferCompact, jupiterSwapInstructions } from "./client";
import type { ApiInstruction } from "./jupiter";
import { assertPlatformFeeQuote, readSwapFeeConfig } from "./fee";
import { feeAccountSetup } from "./collection";
export type ExitSwapRoute = { setupInstructions: ApiInstruction[]; otherInstructions: ApiInstruction[];
  swapInstruction: ApiInstruction; cleanupInstruction?: ApiInstruction | null; addressLookupTableAddresses: string[] };

/** Unsigned withdrawal conversion collects its platform fee in output USDC. */
export async function buildExitSwapLeg(input: { connection: Connection; owner: PublicKey; mint: PublicKey;
  program: PublicKey; source?: PublicKey; decimals: number; amount: bigint; native: boolean;
  signal?: AbortSignal; fetcher?: typeof fetch }) {
  const { connection, owner, mint, source, amount, native, signal, fetcher } = input;
  if (amount <= 0n) throw new Error("Exit swap amount must be positive");
  if (mint.toBase58() === USDC_MINT) throw new Error("Exit conversion must actually swap");
  const config = readSwapFeeConfig();
  if (!native && !source) throw new Error("Exit token swap requires its withdrawal recipient");
  const setup = config.wallet && config.bps > 0 ? await feeAccountSetup(connection, owner, config.wallet) : null;
  const fee = setup?.instructions ?? [];
  const swapAmount = amount;
  const quote = await jupiterQuotePreferCompact({ inputMint: mint.toBase58(), outputMint: USDC_MINT,
    amount: swapAmount.toString(), platformFeeBps: config.bps, slippageBps: 50, signal, fetcher });
  assertPlatformFeeQuote(quote, config.bps);
  if (quote.inputMint !== mint.toBase58() || quote.outputMint !== USDC_MINT || quote.inAmount !== swapAmount.toString() ||
    quote.swapMode !== "ExactIn" || typeof quote.outAmount !== "string" || !/^\d+$/.test(quote.outAmount) || BigInt(quote.outAmount) <= 0n ||
    typeof quote.otherAmountThreshold !== "string" || !/^\d+$/.test(quote.otherAmountThreshold) ||
    BigInt(quote.otherAmountThreshold) <= 0n || BigInt(quote.otherAmountThreshold) > BigInt(quote.outAmount) ||
    !Array.isArray(quote.routePlan) || !quote.routePlan.length) throw new Error("Exit quote context/amount invalid");
  const route = await jupiterSwapInstructions<ExitSwapRoute>({ userPublicKey: owner.toBase58(), quoteResponse: quote,
    feeAccount: setup?.address.toBase58(), wrapAndUnwrapSol: native, dynamicComputeUnitLimit: false, prioritizationFeeLamports: 0 }, { signal, fetcher });
  if (!route.swapInstruction || !Array.isArray(route.addressLookupTableAddresses)) throw new Error("Exit route instructions missing");
  return { route, fee, quote: { mint: mint.toBase58(), inputAtomic: swapAmount.toString(), feeAmount: String((quote.platformFee as { amount?: string } | undefined)?.amount ?? "0"),
    outputUSDCAtomic: quote.outAmount, thresholdUSDCAtomic: quote.otherAmountThreshold, observedAt: new Date().toISOString() } };
}

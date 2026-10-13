import "server-only";
import { PublicKey, type Connection } from "@solana/web3.js";
import { USDC_MINT } from "../ids";
import { jupiterQuotePreferCompact, jupiterSwapInstructions } from "./client";
import type { ApiInstruction } from "./jupiter";
import { assertNativeSwapFeeRecipient, netSwapInput, resolveSwapFeeConfig, swapFeeTransferInstructions } from "./fee";
export type ExitSwapRoute = { setupInstructions: ApiInstruction[]; otherInstructions: ApiInstruction[];
  swapInstruction: ApiInstruction; cleanupInstruction?: ApiInstruction | null; addressLookupTableAddresses: string[] };

/** Unsigned withdrawal conversion uses the same client, config and input fee. */
export async function buildExitSwapLeg(input: { connection: Connection; owner: PublicKey; mint: PublicKey;
  program: PublicKey; source?: PublicKey; decimals: number; amount: bigint; native: boolean;
  signal?: AbortSignal; fetcher?: typeof fetch }) {
  const { connection, owner, mint, program, source, decimals, amount, native, signal, fetcher } = input;
  if (amount <= 0n) throw new Error("Exit swap amount must be positive");
  if (mint.toBase58() === USDC_MINT) throw new Error("Exit conversion must actually swap");
  const config = await resolveSwapFeeConfig(connection, mint, program, native);
  const { feeAmount, swapAmount } = netSwapInput(amount, config.bps);
  if (native && config.wallet) await assertNativeSwapFeeRecipient(connection, config.wallet, feeAmount);
  if (!native && !source) throw new Error("Exit token swap requires its withdrawal recipient");
  const fee = config.wallet && feeAmount > 0n ? swapFeeTransferInstructions(native
    ? { payer: owner, owner, recipient: config.wallet, amount: feeAmount, kind: "native" }
    : { payer: owner, owner, recipient: config.wallet, amount: feeAmount, kind: "token", mint, source: source!, decimals, program }) : [];
  const quote = await jupiterQuotePreferCompact({ inputMint: mint.toBase58(), outputMint: USDC_MINT,
    amount: swapAmount.toString(), slippageBps: 50, signal, fetcher });
  if (quote.inputMint !== mint.toBase58() || quote.outputMint !== USDC_MINT || quote.inAmount !== swapAmount.toString() ||
    quote.swapMode !== "ExactIn" || typeof quote.outAmount !== "string" || !/^\d+$/.test(quote.outAmount) || BigInt(quote.outAmount) <= 0n ||
    typeof quote.otherAmountThreshold !== "string" || !/^\d+$/.test(quote.otherAmountThreshold) ||
    BigInt(quote.otherAmountThreshold) <= 0n || BigInt(quote.otherAmountThreshold) > BigInt(quote.outAmount) ||
    !Array.isArray(quote.routePlan) || !quote.routePlan.length) throw new Error("Exit quote context/amount invalid");
  const route = await jupiterSwapInstructions<ExitSwapRoute>({ userPublicKey: owner.toBase58(), quoteResponse: quote,
    wrapAndUnwrapSol: native, dynamicComputeUnitLimit: false, prioritizationFeeLamports: 0 }, { signal, fetcher });
  if (!route.swapInstruction || !Array.isArray(route.addressLookupTableAddresses)) throw new Error("Exit route instructions missing");
  return { route, fee, quote: { mint: mint.toBase58(), inputAtomic: swapAmount.toString(), feeAmount: feeAmount.toString(),
    outputUSDCAtomic: quote.outAmount, thresholdUSDCAtomic: quote.otherAmountThreshold, observedAt: new Date().toISOString() } };
}

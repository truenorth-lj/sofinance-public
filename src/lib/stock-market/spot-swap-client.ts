/**
 * Browser half of the homepage Buy (USDC -> stock token): quote and prepare through the Jupiter browser relay like the
 * other flows, then the shared `runTx` pipeline (wallet signs; a sign-only wallet falls back to `/api/tx-send` with the
 * prepare-issued permit and the strict byte match). Error text comes from the server and is already plain.
 */
import { VersionedTransaction } from "@solana/web3.js";
import { postWithJupiterRelay, type JupiterRelayStore } from "@/lib/jupiter/browser-relay";
import { TX_PREFLIGHT_POLICY, TxNotSentError, type PreparedTx, type TxAdapter } from "@/lib/tx-pipeline";

export const SPOT_SWAP_PREPARE_TIMEOUT_MS = 45_000;
export const SPOT_SWAP_QUOTE_TIMEOUT_MS = 30_000;
const GENERIC_QUOTE_ERROR = "We couldn't get a price right now. Please try again in a moment.";
const MISMATCH = "The prepared purchase does not match your request. Nothing was sent; please try again.";

export type SpotSwapQuoteView = {
  outputMint: string; outputMintShort: string; outputSymbol: string; issuerName: string; xstocks: boolean;
  amount: string; feeBps: number; feeAmount: string; feeWalletShort: string; quotedOut: string; minOut: string;
  priceImpactPct: string | null; newAccountRentLamports: number | string; baseNetworkFeeLamports: number | string;
  outputDecimals: number; slippageBps: number;
};
export type SpotSwapWalletView = {
  walletLamports: string; outputAccountExists: boolean; requiredLamports: string; solSufficient: boolean;
  usdcBalance: string; usdcSufficient: boolean;
};
export type SpotSwapQuoteResult = { underlying: string; quote: SpotSwapQuoteView; wallet: SpotSwapWalletView | null };

export class SpotSwapQuoteError extends Error {
  constructor(message: string, readonly code: string | null) {
    super(message);
    this.name = "SpotSwapQuoteError";
  }
}

export async function fetchSpotSwapQuote(input: { underlying: string; amount: string; wallet: string | null; store: JupiterRelayStore; signal?: AbortSignal }): Promise<SpotSwapQuoteResult> {
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(SPOT_SWAP_QUOTE_TIMEOUT_MS)]) : AbortSignal.timeout(SPOT_SWAP_QUOTE_TIMEOUT_MS);
  const response = await postWithJupiterRelay("/api/spot-swap-quote", { underlying: input.underlying, amount: input.amount, ...(input.wallet ? { wallet: input.wallet } : {}) },
    { store: input.store, signal });
  const body = await response.json().catch(() => null) as (SpotSwapQuoteResult & { error?: string; code?: string }) | null;
  if (!response.ok || !body?.quote) throw new SpotSwapQuoteError(body?.error || GENERIC_QUOTE_ERROR, body?.code ?? null);
  return body;
}

/** New route terms when the minimum fell below the confirmed one (nothing was prepared). */
export type SpotSwapChangedTerms = { quotedOut: string; minOut: string; priceImpactPct: string | null };
/**
 * `minOut` is the minimum received the user saw (raw units). The server builds nothing below it, and the prepared
 * summary is checked against it again here. When the route moved below it, `onQuoteChanged` gets the new terms to show.
 */
export type SpotSwapInput = { underlying: string; mint: string; amount: string; minOut: string; store: JupiterRelayStore;
  onQuoteChanged?: (terms: SpotSwapChangedTerms) => void };
export type SpotSwapPrepared = PreparedTx & { summary: { outputMint: string; amount: string; quotedOut: string; minOut: string; outputDecimals: number; outputSymbol: string } };

const RAW = /^\d{1,20}$/;
const raw = (value: unknown): bigint | null => typeof value === "string" && RAW.test(value) ? BigInt(value) : null;

function changedTerms(value: unknown): SpotSwapChangedTerms | null {
  const terms = value as Partial<SpotSwapChangedTerms> | null;
  if (!terms || raw(terms.quotedOut) === null || raw(terms.minOut) === null) return null;
  const impact = typeof terms.priceImpactPct === "string" ? terms.priceImpactPct : null;
  return { quotedOut: terms.quotedOut!, minOut: terms.minOut!, priceImpactPct: impact };
}

function decode(base64: string): VersionedTransaction {
  return VersionedTransaction.deserialize(Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)));
}

export const spotSwapTxAdapter: TxAdapter<SpotSwapInput, SpotSwapPrepared> = {
  flow: "buy",
  successTitle: "Stock token bought",
  preflight: TX_PREFLIGHT_POLICY,
  scope: (input) => `buy:${input.mint}`,
  async prepare(input, { wallet }) {
    const confirmedMin = raw(input.minOut);
    if (confirmedMin === null) throw new TxNotSentError(MISMATCH);
    const response = await postWithJupiterRelay("/api/spot-swap-prepare",
      { wallet, underlying: input.underlying, mint: input.mint, amount: input.amount, minOut: input.minOut },
      { store: input.store, signal: AbortSignal.timeout(SPOT_SWAP_PREPARE_TIMEOUT_MS) });
    const data = await response.json().catch(() => null) as { unsignedTransaction?: string; sendPermit?: string; landedPermit?: string;
      summary?: SpotSwapPrepared["summary"] & { wallet: string; lastValidBlockHeight: number }; error?: string; code?: string; quote?: unknown } | null;
    if (!response.ok || !data) {
      const terms = data?.code === "spot_swap_quote_changed" ? changedTerms(data.quote) : null;
      if (terms) input.onQuoteChanged?.(terms);
      throw Object.assign(new TxNotSentError(data?.error || "Couldn't prepare the purchase. Nothing was sent; please try again."), { code: data?.code });
    }
    const summary = data.summary;
    if (!data.unsignedTransaction || !summary || summary.wallet !== wallet || summary.outputMint !== input.mint) throw new TxNotSentError(MISMATCH);
    // Never hand the wallet a purchase whose minimum is below the one the user confirmed.
    const preparedMin = raw(summary.minOut);
    if (preparedMin === null || preparedMin < confirmedMin) throw new TxNotSentError(MISMATCH);
    const transaction = decode(data.unsignedTransaction);
    const message = transaction.message;
    const signers = message.staticAccountKeys.slice(0, message.header.numRequiredSignatures).map((key) => key.toBase58());
    if (signers.length !== 1 || signers[0] !== wallet) throw new TxNotSentError(MISMATCH);
    return { transaction, summary, lastValidBlockHeight: summary.lastValidBlockHeight, sendPermit: data.sendPermit, landedPermit: data.landedPermit };
  },
};

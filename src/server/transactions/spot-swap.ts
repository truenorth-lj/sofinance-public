import "@/lib/engine-host";
import "server-only";
/**
 * In-app spot swap (USDC -> stock token) for the homepage Buy button. The allowlist always comes from the server's
 * cached market + eligibility (`loadSpotSwapStockContext`), never from the client.
 */
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { PublicKey, type Connection } from "@solana/web3.js";
import { parseTokenAmount } from "@sofinance/engine/amount";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { USDC_MINT, SLIPPAGE_BPS } from "@sofinance/engine/ids";
import { rpcConnection } from "@sofinance/engine/rpc";
import { JupiterNoRouteError } from "@sofinance/engine/swap/jupiter";
import {
  buildAndSimulateSpotSwap, quoteSpotSwap, selectSpotSwapToken, SpotSwapError, SPOT_SWAP_BASE_FEE_LAMPORTS, USDC_DECIMALS,
  type SpotSwapQuote,
} from "@sofinance/engine/spot-swap";
import { issueSpotSwapPermit } from "@/lib/spot-swap-permit";
import { withFeeEstimateRetry } from "@/lib/rpc-fee-estimate";
import { txPermitsFor } from "@/lib/tx-send/permit";
import { spotSwapAllowlistFor, type SpotSwapStockContext } from "@/lib/stock-market/buy";

/** No issuer token of this stock has a Jupiter route for this amount. */
export class SpotSwapNoRouteError extends Error {
  constructor() {
    super("There's no trading route for this amount right now. Try a different amount.");
    this.name = "SpotSwapNoRouteError";
  }
}

export type SpotSwapWalletCheck = {
  walletLamports: string; outputAccountExists: boolean; requiredLamports: string; solSufficient: boolean;
  usdcBalance: string; usdcSufficient: boolean;
};

export type SpotSwapQuoteResponse = {
  underlying: string;
  quote: SpotSwapQuote & { outputDecimals: number; slippageBps: number };
  wallet: SpotSwapWalletCheck | null;
};

/**
 * Quote `amount` USDC of this stock. The engine picks the issuer for THIS amount (`selectSpotSwapToken`, xStocks
 * first); each candidate's route check is the full read-only quote, so a quote above 1% price impact is refused
 * with the engine's message and the next issuer is tried. Over 1% for every issuer -> that refusal is thrown.
 */
export async function quoteSpotSwapForStock(context: SpotSwapStockContext, amount: string, wallet: string | null,
  options: { connection?: Connection } = {}): Promise<SpotSwapQuoteResponse> {
  const allowlist = spotSwapAllowlistFor(context.candidates);
  const quotes = new Map<string, SpotSwapQuote>();
  let refusal: SpotSwapError | null = null;
  const usdcRaw = parseTokenAmount(amount, USDC_DECIMALS);
  const selection = await selectSpotSwapToken(allowlist, context.underlying, {
    usdcRaw,
    checkRoute: async (mint) => {
      try {
        quotes.set(mint, await quoteSpotSwap(mint, amount, { allowlist, connection: options.connection }));
        return "ok";
      } catch (error) {
        if (error instanceof JupiterNoRouteError) return "no_route";
        if (error instanceof SpotSwapError && error.code === "spot_swap_price_impact") { refusal ??= error; return "price_impact"; }
        throw error;
      }
    },
  });
  if (selection.status !== "selected") throw refusal ?? new SpotSwapNoRouteError();
  const quote = quotes.get(selection.mint)!;
  const candidate = context.candidates.find((item) => item.mint === selection.mint)!;
  const walletCheck = wallet ? await checkSpotSwapWallet(wallet, candidate, quote, options.connection ?? rpcConnection()) : null;
  return {
    underlying: context.underlying,
    quote: { ...quote, outputDecimals: candidate.decimals, slippageBps: SLIPPAGE_BPS },
    wallet: walletCheck,
  };
}

/** Same SOL rule as the engine's early check: output-account deposit (if missing) + base network fee. */
export async function checkSpotSwapWallet(wallet: string, candidate: { mint: string; program: string }, quote: Pick<SpotSwapQuote, "amount" | "newAccountRentLamports">,
  connection: Connection): Promise<SpotSwapWalletCheck> {
  const owner = new PublicKey(wallet);
  const outputAta = getAssociatedTokenAddressSync(new PublicKey(candidate.mint), owner, false, new PublicKey(candidate.program));
  const usdcAta = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), owner, false, TOKEN_PROGRAM_ID);
  const [walletInfo, outputInfo, usdcInfo] = await connection.getMultipleAccountsInfo([owner, outputAta, usdcAta], "confirmed");
  let usdc = 0n;
  if (usdcInfo && usdcInfo.owner.equals(TOKEN_PROGRAM_ID)) {
    try { usdc = unpackAccount(usdcAta, usdcInfo, TOKEN_PROGRAM_ID).amount; } catch { usdc = 0n; }
  }
  const lamports = BigInt(walletInfo?.lamports ?? 0);
  const outputAccountExists = Boolean(outputInfo);
  const required = (outputAccountExists ? 0n : BigInt(quote.newAccountRentLamports)) + BigInt(SPOT_SWAP_BASE_FEE_LAMPORTS);
  return {
    walletLamports: lamports.toString(), outputAccountExists, requiredLamports: required.toString(), solSufficient: lamports >= required,
    usdcBalance: usdc.toString(), usdcSufficient: usdc >= BigInt(quote.amount),
  };
}

/** Build + simulate for the user's wallet; returns the unsigned transaction and its permits. */
export async function prepareSpotSwapForStock(context: SpotSwapStockContext, wallet: string, mint: string, amount: string) {
  const allowlist = spotSwapAllowlistFor(context.candidates);
  const { summary, transaction } = await withFeeEstimateRetry(() => buildAndSimulateSpotSwap(wallet, mint, amount, { allowlist }));
  const secret = getSigningSecret();
  const unsignedTransaction = Buffer.from(transaction.serialize()).toString("base64");
  const permit = issueSpotSwapPermit(secret, { wallet, message: Buffer.from(transaction.message.serialize()).toString("base64"), summary });
  return { summary, permit, unsignedTransaction, ...txPermitsFor(wallet, unsignedTransaction, summary.lastValidBlockHeight, secret) };
}

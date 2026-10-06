import { parseSelectedQuoteRequest } from "@/lib/api-input";
import { apiError } from "@/lib/api-response";
import { buildAndSimulateSelectedZap } from "@/lib/selected-atomic";
import { issueSelectedPermit } from "@/lib/selected-permit";

export async function POST(request: Request) {
  try {
    const { wallet, selection, amount, floorBps, toleranceBps } = await parseSelectedQuoteRequest(request);
    const { summary, transaction } = await buildAndSimulateSelectedZap(wallet, selection, amount, floorBps, toleranceBps);
    const permit = issueSelectedPermit(process.env.JUPITER_API_KEY || "", {
      message: Buffer.from(transaction.message.serialize()).toString("base64"), wallet, selection,
      requested: summary.quote.requested, floorBps: summary.quote.floorBps,
      expiresAt: summary.expiresAt, lastValidBlockHeight: summary.lastValidBlockHeight,
      startingLiquidity: summary.startingLiquidity, expectedLiquidity: summary.quote.liquidity,
      rangeSide: summary.quote.rangeSide, startingBalances: summary.startingBalances,
    });
    return Response.json({ ...summary, permit,
      unsignedTransaction: Buffer.from(transaction.serialize()).toString("base64") }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiError(error, "Transaction preparation failed");
  }
}

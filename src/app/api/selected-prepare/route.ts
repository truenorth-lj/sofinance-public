import { withSelectedDeadline } from "@/lib/selected-deadline";
import { parseSelectedQuoteRequest } from "@/lib/api-input";
import { selectedApiError } from "@/lib/api-response";
import { buildAndSimulateSelectedZap } from "@/lib/selected-atomic";
import { issueSelectedPermit } from "@/lib/selected-permit";
import { getSigningSecret } from "@/lib/config/server-env";

export async function POST(request: Request) {
  return withSelectedDeadline(request, async (signal, budget) => {
  try {
    const { wallet, selection, amount, floorBps, toleranceBps } = await parseSelectedQuoteRequest(request);
    const { summary, transaction } = await buildAndSimulateSelectedZap(wallet, selection, amount, floorBps, toleranceBps,
      { enforceResaleFloor: false, signal, budget });
    signal.throwIfAborted();
    const permit = issueSelectedPermit(getSigningSecret(), {
      message: Buffer.from(transaction.message.serialize()).toString("base64"), wallet, selection,
      requested: summary.quote.requested, floorBps: summary.quote.floorBps,
      expiresAt: summary.expiresAt, lastValidBlockHeight: summary.lastValidBlockHeight,
      startingLiquidity: summary.startingLiquidity, expectedLiquidity: summary.quote.liquidity,
      rangeSide: summary.quote.rangeSide, startingBalances: summary.startingBalances,
    });
    signal.throwIfAborted();
    return Response.json({ ...summary, permit,
      unsignedTransaction: Buffer.from(transaction.serialize()).toString("base64") }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return selectedApiError(error, "Transaction preparation failed");
  }
  });
}

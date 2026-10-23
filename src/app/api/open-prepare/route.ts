import "@/lib/engine-host";
import { withJupiterRelay } from "@/lib/jupiter-relay-route";
import { parseOpenQuoteRequest } from "@/lib/open-api";
import { apiError } from "@/lib/api-response";
import { buildAndSimulateOpenPosition } from "@sofinance/engine/open-atomic";
import { issueOpenPositionPermit } from "@/lib/open-permit";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { withFeeEstimateRetry } from "@/lib/rpc-fee-estimate";

export async function POST(request: Request) {
  return withJupiterRelay(request, async () => {
  try {
    const { wallet, selection, amount, range, floorBps, toleranceBps } = await parseOpenQuoteRequest(request);
    const { summary, transaction } = await withFeeEstimateRetry(() => buildAndSimulateOpenPosition(
      wallet, selection, amount, range, floorBps, toleranceBps, { enforceResaleFloor: false },
    ));
    const permit = issueOpenPositionPermit(getSigningSecret(), {
      wallet,
      message: Buffer.from(transaction.message.serialize()).toString("base64"),
      summary,
    });
    return Response.json({
      summary, permit,
      unsignedTransaction: Buffer.from(transaction.serialize()).toString("base64"),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error, "Open-position preparation failed");
  }
  });
}

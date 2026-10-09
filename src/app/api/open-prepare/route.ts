import { parseOpenQuoteRequest } from "@/lib/open-api";
import { apiError } from "@/lib/api-response";
import { buildAndSimulateOpenPosition } from "@/lib/open-atomic";
import { issueOpenPositionPermit } from "@/lib/open-permit";

export async function POST(request: Request) {
  try {
    const { wallet, selection, amount, range, toleranceBps } = await parseOpenQuoteRequest(request);
    const { summary, transaction } = await buildAndSimulateOpenPosition(
      wallet, selection, amount, range, toleranceBps,
    );
    const permit = issueOpenPositionPermit(process.env.JUPITER_API_KEY || "", {
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
}

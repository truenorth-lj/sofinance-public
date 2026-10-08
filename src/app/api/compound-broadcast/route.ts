import { parseCompoundBroadcast } from "@/lib/compound-api";
import { CompoundSendError, sendSignedCompoundTransaction } from "@/lib/compound-send";
import { apiError } from "@/lib/api-response";
import type { CompoundSummary } from "@/lib/compound-types";

export async function POST(request: Request) {
  try {
    const parsed = await parseCompoundBroadcast(request, "compound");
    const { signature } = await sendSignedCompoundTransaction(
      parsed.wallet, parsed.transaction, parsed.summary as CompoundSummary,
    );
    return Response.json({ signature }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const sent = error instanceof CompoundSendError ? error.sent : false;
    return apiError(error, "Compound transaction broadcast failed", 400, sent === false ? { sent: false } : undefined);
  }
}

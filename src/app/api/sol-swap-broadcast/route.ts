import "@/lib/engine-host";
import { parseWallet } from "@sofinance/engine/api-input";
import type { SolSwapStepSummary } from "@sofinance/engine/sol-swap-step";
import { apiError } from "@/lib/api-response";
import { CompoundSendError } from "@/lib/public-error";
import { sendSignedSolSwapStep } from "@/server/transactions/sol-swap-step";

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      signedTransaction?: unknown; unsignedTransaction?: unknown; permit?: unknown; wallet?: unknown; summary?: unknown;
    };
    const wallet = parseWallet(body.wallet);
    if (typeof body.signedTransaction !== "string" || body.signedTransaction.length > 2_500 ||
      typeof body.unsignedTransaction !== "string" || body.unsignedTransaction.length > 2_500 ||
      typeof body.permit !== "string" || !body.summary || typeof body.summary !== "object") {
      throw new CompoundSendError(new Error("Invalid or expired signed SOL swap input"), false);
    }
    const result = await sendSignedSolSwapStep({
      signedTransaction: body.signedTransaction, unsignedTransaction: body.unsignedTransaction,
      permit: body.permit, wallet, summary: body.summary as SolSwapStepSummary,
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const sent = error instanceof CompoundSendError ? error.sent : false;
    return apiError(error, "SOL swap broadcast failed", 400, sent === false ? { sent: false } : undefined);
  }
}

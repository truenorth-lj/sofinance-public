import "@/lib/engine-host";
import { VersionedTransaction } from "@solana/web3.js";
import { parseWallet } from "@sofinance/engine/api-input";
import { apiError } from "@/lib/api-response";
import { CompoundSendError } from "@/lib/public-error";
import { submitOpenPositionFromParts } from "@/lib/open-send";
import type { OpenPositionSummary } from "@sofinance/engine/open-types";

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      signedTransaction?: string; unsignedTransaction?: string; permit?: string;
      wallet?: string; summary?: OpenPositionSummary; sourceRef?: unknown;
    };
    const wallet = parseWallet(body.wallet);
    if (typeof body.signedTransaction !== "string" || body.signedTransaction.length > 2_500 ||
      (body.unsignedTransaction !== undefined && (typeof body.unsignedTransaction !== "string" ||
        body.unsignedTransaction.length > 2_500)) ||
      typeof body.permit !== "string" || !body.summary || typeof body.summary !== "object") {
      throw new Error("Invalid or expired signed open-position input");
    }
    VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64"));
    const result = await submitOpenPositionFromParts({
      signedTransaction: body.signedTransaction,
      unsignedTransaction: body.unsignedTransaction,
      permit: body.permit,
      wallet,
      summary: body.summary,
      sourceRef: body.sourceRef,
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const sent = error instanceof CompoundSendError ? error.sent : false;
    return apiError(error, "Open-position broadcast failed", 400, sent === false ? { sent: false } : undefined);
  }
}

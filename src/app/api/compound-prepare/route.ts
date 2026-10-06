import { parseCompoundSelection } from "@/lib/compound-api";
import { buildAndSimulateCompound } from "@/lib/compound-atomic";
import { issueCompoundPermit } from "@/lib/compound-permit";
import { apiError } from "@/lib/api-response";

export async function POST(request: Request) {
  try {
    const { wallet, positionMint, sourceSignatures } = await parseCompoundSelection(request);
    const { summary, transaction } = await buildAndSimulateCompound(wallet, positionMint, sourceSignatures);
    const permit = issueCompoundPermit(process.env.JUPITER_API_KEY || "", { wallet, summary,
      message: Buffer.from(transaction.message.serialize()).toString("base64") });
    return Response.json({ summary, permit, unsignedTransaction: Buffer.from(transaction.serialize()).toString("base64") },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error, "Compound transaction preparation failed"); }
}

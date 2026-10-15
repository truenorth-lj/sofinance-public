import "@/lib/engine-host";
import { parseCompoundSelection } from "@/lib/compound-api";
import { buildAndSimulateCompound } from "@sofinance/engine/compound-atomic";
import { issueCompoundPermit } from "@/lib/compound-permit";
import { apiError } from "@/lib/api-response";
import { getSigningSecret } from "@sofinance/engine/config/server-env";

export async function POST(request: Request) {
  try {
    const { wallet, positionMint, sourceSignatures } = await parseCompoundSelection(request);
    const { summary, transaction } = await buildAndSimulateCompound(wallet, positionMint, sourceSignatures);
    const permit = issueCompoundPermit(getSigningSecret(), { wallet, summary,
      message: Buffer.from(transaction.message.serialize()).toString("base64") });
    return Response.json({ summary, permit, unsignedTransaction: Buffer.from(transaction.serialize()).toString("base64") },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error, "Compound transaction preparation failed"); }
}

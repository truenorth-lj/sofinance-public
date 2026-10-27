import "@/lib/engine-host";
import { parseCompoundSelection } from "@/lib/compound-api";
import { prepareCompound } from "@/server/transactions/compound-prepare";
import { apiError } from "@/lib/api-response";

export async function POST(request: Request) {
  try {
    const { wallet, positionMint, sourceSignatures } = await parseCompoundSelection(request);
    const prepared = await prepareCompound({ wallet, positionMint, sourceSignatures });
    return Response.json(prepared,
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error, "Compound transaction preparation failed"); }
}

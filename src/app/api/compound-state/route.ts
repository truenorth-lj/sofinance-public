import { parseCompoundSelection } from "@/lib/compound-api";
import { readCompoundPositionState } from "@/lib/compound-state";
import { apiError } from "@/lib/api-response";

export async function POST(request: Request) {
  try {
    const { wallet, positionMint } = await parseCompoundSelection(request);
    return Response.json(await readCompoundPositionState(wallet, positionMint), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error, "Yield reading failed"); }
}

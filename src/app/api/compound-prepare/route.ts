import "@/lib/engine-host";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { parseCompoundSelection } from "@/lib/compound-api";
import { prepareCompound, APP_COMPOUND_PREPARE } from "@/lib/dex";
import { apiError } from "@/lib/api-response";

export async function POST(request: Request) {
  try {
    const { wallet, positionMint, sourceSignatures } = await parseCompoundSelection(request);
    const prepared = await prepareCompound("raydium-clmm", { wallet, positionMint, sourceSignatures }, getSigningSecret, APP_COMPOUND_PREPARE);
    return Response.json(prepared,
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error, "Compound transaction preparation failed"); }
}

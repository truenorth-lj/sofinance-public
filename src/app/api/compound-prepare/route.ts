import "@/lib/engine-host";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { parseCompoundSelection } from "@/lib/compound-api";
import { prepareCompound } from "@/server/transactions/compound-prepare";
import { APP_COMPOUND_PREPARE } from "@/server/transactions/surface-policy";
import { apiError } from "@/lib/api-response";

export async function POST(request: Request) {
  try {
    const { wallet, positionMint, sourceSignatures } = await parseCompoundSelection(request);
    const prepared = await prepareCompound({ wallet, positionMint, sourceSignatures }, getSigningSecret, APP_COMPOUND_PREPARE);
    return Response.json(prepared,
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error, "Compound transaction preparation failed"); }
}

import "@/lib/engine-host";
import { parseWallet } from "@sofinance/engine/api-input";
import { readCompoundBody } from "@/lib/compound-api";
import { prepareCompoundRecovery } from "@/lib/dex";
import { apiError } from "@/lib/api-response";
import { getSigningSecret } from "@sofinance/engine/config/server-env";

export async function POST(request: Request) {
  try {
    const body = await readCompoundBody(request);
    const wallet = parseWallet(body.wallet);
    const prepared = await prepareCompoundRecovery("raydium-clmm", { wallet, compoundAccounts: body.compoundAccounts }, getSigningSecret);
    return Response.json(prepared, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error, "Remaining harvest recovery preparation failed"); }
}

import "@/lib/engine-host";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { withJupiterRelay } from "@/lib/jupiter-relay-route";
import { parseOpenPrepareRequest } from "@/lib/open-api";
import { apiError } from "@/lib/api-response";
import { prepareOpen, APP_OPEN_PREPARE } from "@/lib/dex";

export async function POST(request: Request) {
  return withJupiterRelay(request, async () => {
  try {
    const { wallet, selection, amount, range, floorBps, toleranceBps, nftMint, solSwapSignature } = await parseOpenPrepareRequest(request);
    const prepared = await prepareOpen("raydium-clmm", { wallet, selection, amount, range, floorBps, toleranceBps, nftMint, solSwapSignature }, getSigningSecret, APP_OPEN_PREPARE);
    return Response.json(prepared, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error, "Open-position preparation failed");
  }
  });
}

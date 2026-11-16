import "@/lib/engine-host";
import { withJupiterRelay } from "@/lib/jupiter-relay-route";
import { prepareWithdrawal, APP_WITHDRAW_PREPARE } from "@/lib/dex";
import { apiError } from "@/lib/api-response";
export async function POST(request: Request) {
  return withJupiterRelay(request, async () => {
    try {
        const body = await request.json();
        const prepared = await prepareWithdrawal("raydium-clmm", body, APP_WITHDRAW_PREPARE);
        return Response.json(prepared, { headers: { "Cache-Control": "no-store" } });
    }
    catch (error) {
        return apiError(error, "Withdrawal preparation failed");
    }
  });
}

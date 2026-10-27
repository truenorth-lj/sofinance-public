import "@/lib/engine-host";
import { withJupiterRelay } from "@/lib/jupiter-relay-route";
import { prepareWithdrawal } from "@/server/transactions/withdraw-prepare";
import { APP_WITHDRAW_PREPARE } from "@/server/transactions/surface-policy";
import { apiError } from "@/lib/api-response";
export async function POST(request: Request) {
  return withJupiterRelay(request, async () => {
    try {
        const body = await request.json();
        const prepared = await prepareWithdrawal(body, APP_WITHDRAW_PREPARE);
        return Response.json(prepared, { headers: { "Cache-Control": "no-store" } });
    }
    catch (error) {
        return apiError(error, "Withdrawal preparation failed");
    }
  });
}

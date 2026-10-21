import "@/lib/engine-host";
import { withJupiterRelay } from "@/lib/jupiter-relay-route";
import { buildWithdraw } from "@sofinance/engine/withdraw/build";
import { withTransientRetry } from "@/lib/withdraw/retry";
import { apiError } from "@/lib/api-response";
export async function POST(request: Request) {
  return withJupiterRelay(request, async () => {
    try {
        const body = await request.json();
        const result = await withTransientRetry(() => buildWithdraw(body, true));
        return Response.json(result.summary, { headers: { "Cache-Control": "no-store" } });
    }
    catch (error) {
        return apiError(error, "Withdrawal preview failed");
    }
  });
}

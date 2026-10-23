import "@/lib/engine-host";
import { withJupiterRelay } from "@/lib/jupiter-relay-route";
import { buildWithdraw } from "@sofinance/engine/withdraw/build";
import { withTransientRetry } from "@/lib/withdraw/retry";
import { refreshWithdrawBlockhash } from "@/lib/withdraw/fresh-prepare";
import { apiError } from "@/lib/api-response";
import { rpcConnection } from "@sofinance/engine/rpc";
export async function POST(request: Request) {
  return withJupiterRelay(request, async () => {
    try {
        const body = await request.json();
        const prepared = await withTransientRetry(() => buildWithdraw(body));
        return Response.json(await refreshWithdrawBlockhash(rpcConnection(), prepared), { headers: { "Cache-Control": "no-store" } });
    }
    catch (error) {
        return apiError(error, "Withdrawal preparation failed");
    }
  });
}

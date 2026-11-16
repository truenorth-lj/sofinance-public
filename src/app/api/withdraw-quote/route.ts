import "@/lib/engine-host";
import { withJupiterRelay } from "@/lib/jupiter-relay-route";
import { quoteWithdrawal } from "@/lib/dex";
import { apiError } from "@/lib/api-response";
export async function POST(request: Request) {
  return withJupiterRelay(request, async () => {
    try {
        const body = await request.json();
        const summary = await quoteWithdrawal("raydium-clmm", body);
        return Response.json(summary, { headers: { "Cache-Control": "no-store" } });
    }
    catch (error) {
        return apiError(error, "Withdrawal preview failed");
    }
  });
}

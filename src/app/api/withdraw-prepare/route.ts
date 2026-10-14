import { buildWithdraw } from "@/lib/withdraw/build";
import { withTransientRetry } from "@/lib/withdraw/retry";
import { apiError } from "@/lib/api-response";
export async function POST(request: Request) {
    try {
        const body = await request.json();
        return Response.json(await withTransientRetry(() => buildWithdraw(body)), { headers: { "Cache-Control": "no-store" } });
    }
    catch (error) {
        return apiError(error, "Withdrawal preparation failed");
    }
}

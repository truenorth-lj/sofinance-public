import { buildWithdraw } from "@/lib/withdraw/build";
import { apiError } from "@/lib/api-response";
export async function POST(request: Request) {
    try {
        return Response.json(await buildWithdraw(await request.json()), { headers: { "Cache-Control": "no-store" } });
    }
    catch (error) {
        return apiError(error, "Withdrawal preparation failed");
    }
}

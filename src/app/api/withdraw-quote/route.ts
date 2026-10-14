import { buildWithdraw } from "@/lib/withdraw/build";
import { apiError } from "@/lib/api-response";
export async function POST(request: Request) {
    try {
        const result = await buildWithdraw(await request.json(), true);
        return Response.json(result.summary, { headers: { "Cache-Control": "no-store" } });
    }
    catch (error) {
        return apiError(error, "Withdrawal preview failed");
    }
}

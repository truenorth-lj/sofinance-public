import { submitWithdraw } from "@/lib/withdraw/send";
import { apiError } from "@/lib/api-response";
export async function POST(request: Request) {
    try {
        return Response.json(await submitWithdraw(await request.json()), { headers: { "Cache-Control": "no-store" } });
    }
    catch (error) {
        return apiError(error, "Withdrawal broadcast failed");
    }
}

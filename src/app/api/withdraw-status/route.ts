import { withdrawStatus } from "@/lib/withdraw/status";
import { apiError } from "@/lib/api-response";
export async function POST(request: Request) {
    try {
        return Response.json(await withdrawStatus(await request.json()), { headers: { "Cache-Control": "no-store" } });
    }
    catch (error) {
        return apiError(error, "Withdrawal verification failed");
    }
}

import { verifySignToken } from "@/lib/pending-sign-token";
import { apiError } from "@/lib/api-response";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { token } = body;
    
    if (!token || typeof token !== "string") {
      return apiError(new Error("Invalid token"), "Invalid token");
    }
    
    const secret = process.env.JUPITER_API_KEY || "";
    if (!secret) {
      return apiError(new Error("Sign token secret not configured"), "Server configuration error");
    }
    
    const payload = await verifySignToken(token, secret);
    
    if (!payload) {
      return apiError(new Error("Token invalid, expired, or malformed"), "Token invalid, expired, or malformed");
    }
    
    return Response.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiError(error, "Failed to verify sign token");
  }
}

import { retrievePendingSign } from "@/lib/pending-sign-store";
import { apiError } from "@/lib/api-response";

export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const params = await props.params;
    const { id } = params;
    
    if (!id || !/^[0-9a-f]{32}$/.test(id)) {
      return apiError(new Error("Invalid sign ID"), "Invalid sign ID");
    }
    
    const payload = retrievePendingSign(id);
    
    if (!payload) {
      return apiError(new Error("Sign payload not found or expired"), "Sign payload not found or expired");
    }
    
    return Response.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiError(error, "Failed to retrieve pending sign payload");
  }
}

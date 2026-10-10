import { apiError } from "@/lib/api-response";
import { fetchBeamLanding, formatBeamLanding } from "@/lib/solami-beam";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const signature = url.searchParams.get("signature")?.trim() ?? "";
    if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)) {
      throw new Error("signature is required");
    }
    const beam = await fetchBeamLanding(signature);
    return Response.json(
      {
        beam,
        beamLabel: beam?.isLanded ? formatBeamLanding(beam) : null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error, "Beam landing lookup failed", 400);
  }
}

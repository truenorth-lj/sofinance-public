import { apiError } from "@/lib/api-response";
import { getPositionPerformance } from "@/lib/position-performance";

export const dynamic = "force-dynamic";

function parsePubkey(raw: string | null, label: string) {
  if (!raw) throw new Error(`${label} is required`);
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw)) throw new Error(`Invalid ${label}`);
  return raw;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const positionMint = parsePubkey(url.searchParams.get("positionMint"), "positionMint");
    const walletRaw = url.searchParams.get("wallet");
    const wallet = walletRaw ? parsePubkey(walletRaw, "wallet") : undefined;
    const maxRaw = url.searchParams.get("maxSignatures");
    const maxSignatures = maxRaw === null || maxRaw === "" ? 100 : Number(maxRaw);
    if (!Number.isInteger(maxSignatures) || maxSignatures < 1 || maxSignatures > 500) {
      throw new Error("maxSignatures must be an integer 1–500");
    }
    const skipPricing = url.searchParams.get("skipPricing") === "1" || url.searchParams.get("skipPricing") === "true";

    const result = await getPositionPerformance(positionMint, {
      wallet,
      maxSignatures,
      skipPricing,
    });

    return Response.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiError(error, "Position performance lookup failed", 400);
  }
}

import { apiError } from "@/lib/api-response";
import { getPositionPerformance } from "@/lib/position-performance";
import { PositionHistoryStoreError } from "@/lib/position-history-store-types";
import bs58 from "bs58";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
    const refreshRaw = url.searchParams.get("refreshHistory");
    if (refreshRaw !== null && refreshRaw !== "0" && refreshRaw !== "1") throw new Error("Invalid history refresh");
    const afterRaw = url.searchParams.get("historyAfterSignatures");
    if (afterRaw && afterRaw.length > 8 * 89) throw new Error("Invalid history signatures");
    const historyAfterSignatures = afterRaw ? [...new Set(afterRaw.split(","))] : undefined;
    if (historyAfterSignatures && (historyAfterSignatures.length > 8 || historyAfterSignatures.some(signature =>
      !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature) || bs58.decode(signature).length !== 64))) {
      throw new Error("Invalid history signatures");
    }

    const result = await getPositionPerformance(positionMint, {
      wallet,
      maxSignatures,
      skipPricing,
      signal: request.signal,
      refreshHistory: refreshRaw === "1",
      historyAfterSignatures,
    });

    return Response.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof PositionHistoryStoreError) return Response.json({
      error: "Position history is temporarily unavailable. Please try again shortly.", code: error.code,
    }, { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "5" } });
    return apiError(error, "Position performance lookup failed", 400);
  }
}

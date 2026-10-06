import { parseWallet } from "@/lib/api-input";
import { apiError } from "@/lib/api-response";
import { discoverWallet } from "@/lib/wallet-discovery";

export async function GET(request: Request) {
  let wallet: string;
  try {
    wallet = parseWallet(new URL(request.url).searchParams.get("wallet"));
  } catch (error) {
    return apiError(error, "Invalid wallet address");
  }
  try {
    return Response.json(await discoverWallet(wallet), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error, "Wallet scan failed", 503);
  }
}

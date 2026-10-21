import "@/lib/engine-host";
import { parseWallet } from "@sofinance/engine/api-input";
import { apiError } from "@/lib/api-response";
import { discoverWallet } from "@sofinance/engine/wallet-discovery";

export async function GET(request: Request) {
  let wallet: string;
  try {
    wallet = parseWallet(new URL(request.url).searchParams.get("wallet"));
  } catch (error) {
    return apiError(error, "Invalid wallet address", 400, { request });
  }
  try {
    return Response.json(await discoverWallet(wallet), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error, "Wallet scan failed", 503, { request });
  }
}

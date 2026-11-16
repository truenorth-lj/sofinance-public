import "@/lib/engine-host";
import { parseWallet } from "@sofinance/engine/api-input";
import { apiError } from "@/lib/api-response";
import { discoverNativeWallet } from "@/lib/dex";
import { rpcReadConnection } from "@sofinance/engine/rpc";
import { NO_STORE_HEADERS } from "@/lib/http/no-store";

export async function GET(request: Request) {
  let wallet: string;
  try {
    wallet = parseWallet(new URL(request.url).searchParams.get("wallet"));
  } catch (error) {
    return apiError(error, "Invalid wallet address", 400, { request });
  }
  try {
    return Response.json(await discoverNativeWallet("raydium-clmm", wallet, rpcReadConnection()), { headers: NO_STORE_HEADERS });
  } catch (error) {
    return apiError(error, "Wallet scan failed", 503, { request });
  }
}

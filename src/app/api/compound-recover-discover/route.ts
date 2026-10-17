import "@/lib/engine-host";
import { parseWallet } from "@sofinance/engine/api-input";
import { rpcConnection } from "@sofinance/engine/rpc";
import { readCompoundBody } from "@/lib/compound-api";
import { discoverCompoundCleanup } from "@/lib/compound-cleanup-discovery";
import { apiError } from "@/lib/api-response";

export async function POST(request: Request) {
  try {
    const body = await readCompoundBody(request);
    const wallet = parseWallet(body.wallet);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(25_000)]);
    const result = await discoverCompoundCleanup(rpcConnection(undefined, { signal }), wallet, body.cursor, signal);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error, "Unable to scan historical compound balances"); }
}

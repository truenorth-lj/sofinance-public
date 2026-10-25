import "@/lib/engine-host";
import { parseCompoundSelection } from "@/lib/compound-api";
import { readCompoundPositionState } from "@sofinance/engine/compound-state";
import { RPC_UNAVAILABLE_CODE } from "@sofinance/engine/jupiter/errors";
import { rpcReadConnection } from "@sofinance/engine/rpc";
import { RpcUnavailableError } from "@sofinance/engine/rpc/errors";
import { apiError } from "@/lib/api-response";
import { publicErrorCode } from "@/lib/public-error";

/** Seconds the browser should wait before re-reading yield after an RPC rate limit. */
const COMPOUND_STATE_RETRY_AFTER_SECONDS = 2;

export async function POST(request: Request) {
  try {
    const { wallet, positionMint } = await parseCompoundSelection(request);
    return Response.json(await readCompoundPositionState(wallet, positionMint, rpcReadConnection()), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof RpcUnavailableError || publicErrorCode(error) === RPC_UNAVAILABLE_CODE) {
      // Transient provider limit on a read-only call: answer 503 + code so the browser can retry
      // quietly instead of treating it as a 400 the user caused.
      const body = await apiError(error, "Yield reading failed", 503).json() as Record<string, unknown>;
      return Response.json({ ...body, code: RPC_UNAVAILABLE_CODE }, { status: 503, headers: {
        "Cache-Control": "no-store", "Retry-After": String(COMPOUND_STATE_RETRY_AFTER_SECONDS),
      } });
    }
    return apiError(error, "Yield reading failed");
  }
}

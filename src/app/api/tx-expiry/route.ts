import "@/lib/engine-host";
import bs58 from "bs58";
import { apiError } from "@/lib/api-response";
import { checkVoidedTx } from "@/lib/tx-simulate/expiry.server";
import { parsePermittedTx } from "@/lib/tx-simulate/permitted-input.server";
import { publicConnection } from "@/lib/tx-simulate/simulate.server";
import { clientIp, txExpiryCheckRateLimited, txExpiryRateLimited } from "@/lib/tx-send/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const isSignature = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 90) return false;
  try { return bs58.decode(value).length === 64; } catch { return false; }
};

/**
 * Read-only, public RPC: after a voided wallet prompt, has the old transaction landed, or has its blockhash expired?
 * The browser keeps Try again disabled until this says "expired". Rate limited per IP, per permit and per wallet.
 */
export async function POST(request: Request) {
  if (txExpiryRateLimited(clientIp(request))) return tooMany();
  let input: Parameters<typeof checkVoidedTx>[1];
  let permit: string;
  try {
    const body = await request.json() as Record<string, unknown> | null;
    const parsed = parsePermittedTx(body);
    const { signature, preparedAt, checked } = body ?? {};
    if ((signature !== undefined && !isSignature(signature)) || !Number.isFinite(preparedAt) ||
      (checked !== undefined && (!Array.isArray(checked) || checked.length > 200 || !checked.every(isSignature)))) {
      throw new Error("Invalid transaction input");
    }
    const now = Math.floor(Date.now() / 1000);
    // Same window as /api/tx-landed: at least 5 min back from the server clock, at most 15.
    const notBefore = Math.max(now - 900, Math.min(now - 300, Math.floor((preparedAt as number) / 1000) - 120));
    input = { wallet: parsed.wallet, prepared: parsed.transaction, lastValidBlockHeight: parsed.lastValidBlockHeight, notBefore,
      ...(signature ? { signature } : {}), ...(checked ? { checked: checked as string[] } : {}) };
    permit = parsed.landedPermit;
  } catch (error) {
    return apiError(error, "Transaction check failed", 400);
  }
  if (txExpiryCheckRateLimited(permit, input.wallet)) return tooMany();
  try {
    return Response.json(await checkVoidedTx(publicConnection(), input), { headers: NO_STORE });
  } catch {
    // RPC trouble is never "expired": the browser keeps waiting.
    return Response.json({ error: "Could not check Solana right now" }, { status: 502, headers: NO_STORE });
  }
}

function tooMany() {
  return Response.json({ error: "Too many checks. Wait a moment and try again." }, { status: 429, headers: { ...NO_STORE, "Retry-After": "10" } });
}

import "@/lib/engine-host";
import { PublicKey } from "@solana/web3.js";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { apiError } from "@/lib/api-response";
import { verifySignToken } from "@/lib/pending-sign-token";
import { prepareOpen } from "@/server/transactions/open-prepare";
import { MCP_OPEN_PREPARE } from "@/server/transactions/surface-policy";
import { sendPermitFor } from "@/lib/tx-send/permit";

/**
 * `/app/sign/<token>` for an MCP open created without `nftMint`: the browser sends
 * the public key of a mint it just generated, and we re-prepare with the token's
 * HMAC-bound inputs (same MCP profile). The mint secret never reaches the server.
 * The MCP profile issues no relay permit, but this page relays through `/api/tx-send` (the mint
 * co-signs after the wallet), so the permit for the re-prepared transaction is added here.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json() as { token?: unknown; nftMint?: unknown };
    if (typeof body.token !== "string" || typeof body.nftMint !== "string") throw new Error("Invalid request");
    const nftMint = new PublicKey(body.nftMint).toBase58();
    const secret = getSigningSecret();
    const payload = await verifySignToken(body.token, secret);
    if (!payload || payload.kind !== "open-position" || !payload.openRequest) {
      return apiError(new Error("Token invalid, expired, or malformed"), "Token invalid, expired, or malformed");
    }
    if (nftMint === payload.wallet) throw new Error("Invalid position NFT mint");
    const { selection, amount, range, floorBps, toleranceBps } = payload.openRequest;
    const prepared = await prepareOpen({ wallet: payload.wallet, selection, amount, range, floorBps, toleranceBps, nftMint },
      getSigningSecret, MCP_OPEN_PREPARE);
    const sendPermit = sendPermitFor(payload.wallet, prepared.unsignedTransaction, secret);
    return Response.json({ ...prepared, sendPermit }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error, "Open-position preparation failed");
  }
}

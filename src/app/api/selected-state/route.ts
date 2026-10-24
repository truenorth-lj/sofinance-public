import "@/lib/engine-host";
import { parseWallet } from "@sofinance/engine/api-input";
import { apiError } from "@/lib/api-response";
import { readSelectedPositionState, type PositionSelection } from "@sofinance/engine/selected-state";
import { PublicKey } from "@solana/web3.js";
import { isInputAssetNotHeldError, INPUT_ASSET_NOT_HELD_CODE, INPUT_ASSET_NOT_HELD_MESSAGE } from "@/lib/selected-input-asset-not-held";
import { isPositionNotHeldError, POSITION_NOT_HELD_CODE, POSITION_NOT_HELD_MESSAGE } from "@/lib/selected-position-not-held";

export async function GET(request: Request) {
  let wallet: string;
  let selection: PositionSelection;
  try {
    const params = new URL(request.url).searchParams;
    wallet = parseWallet(params.get("wallet"));
    const positionMint = new PublicKey(params.get("positionMint") || "").toBase58();
    const inputMint = new PublicKey(params.get("inputMint") || "").toBase58();
    const inputKind = params.get("inputKind");
    if (inputKind !== "native" && inputKind !== "token") throw new Error("Invalid input asset type");
    selection = { positionMint, inputMint, inputKind };
  } catch {
    return apiError(new Error("Wallet or selection data incorrect"), "Selection data incorrect");
  }
  try {
    return Response.json(await readSelectedPositionState(wallet, selection), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isPositionNotHeldError(error)) {
      return Response.json({ error: POSITION_NOT_HELD_MESSAGE, code: POSITION_NOT_HELD_CODE },
        { status: 409, headers: { "Cache-Control": "no-store" } });
    }
    if (isInputAssetNotHeldError(error)) {
      return Response.json({ error: INPUT_ASSET_NOT_HELD_MESSAGE, code: INPUT_ASSET_NOT_HELD_CODE },
        { status: 409, headers: { "Cache-Control": "no-store" } });
    }
    return apiError(error, "Selected position state reading failed", 503);
  }
}

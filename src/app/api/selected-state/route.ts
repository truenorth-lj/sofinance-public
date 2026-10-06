import { parseWallet } from "@/lib/api-input";
import { apiError } from "@/lib/api-response";
import { readSelectedPositionState, type PositionSelection } from "@/lib/selected-state";
import { PublicKey } from "@solana/web3.js";

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
    return apiError(error, "Selected position state reading failed", 503);
  }
}

import "server-only";
import "@/lib/engine-host";
import bs58 from "bs58";
import { rpcConnection } from "@sofinance/engine/rpc";
import { invalidatePositionHistoryCache } from "@/lib/position-history-cache";
import { APP_SELECTED_SUBMIT, validateSignedAdd, type SelectedSubmitCommand, type SelectedSubmitProfile } from "@/lib/dex";
import { broadcastSignedTransaction } from "@/lib/broadcast-signed-transaction";

// Internal RPC stage only. The adapters must retain their runtime permit and
// structure checks, in their original order; this type is not authorization proof.
// Never rebuild the signed transaction or classify a send failure as unsent here.
export async function submitSelected(
  { transaction, wallet, walletSignature, permitInput, prepared }: SelectedSubmitCommand,
  profile: SelectedSubmitProfile,
) {
  const app = profile === APP_SELECTED_SUBMIT;
  // Snapshot authenticated facts before the lazy validation seam; signed transaction objects stay intact.
  const input = structuredClone(permitInput);
  const expectedSignature = bs58.encode(walletSignature);
  const connection = rpcConnection();
  await validateSignedAdd("raydium-clmm", { transaction, wallet, permitInput: input, prepared }, connection, profile);
  const signature = await broadcastSignedTransaction({
    connection, transaction, expectedSignature,
    expiry: { lastValidBlockHeight: input.lastValidBlockHeight, expiresAt: input.expiresAt },
    expiredMessage: "Signed transaction expired before broadcast",
    mismatchMessage: app
      ? "Dedicated RPC returned transaction signature mismatch"
      : "RPC returned transaction signature mismatch",
  });
  invalidatePositionHistoryCache(input.selection.positionMint);
  return signature;
}

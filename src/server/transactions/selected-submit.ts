import "server-only";
import "@/lib/engine-host";
import type { PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { rpcConnection } from "@sofinance/engine/rpc";
import { readSelectedPositionState } from "@sofinance/engine/selected-state";
import type { SelectedPermitInput } from "@/lib/selected-permit";
import { simulateAndVerifySelectedTransaction } from "@/lib/selected-simulation";
import { invalidatePositionHistoryCache } from "@/lib/position-history-cache";
import { APP_SELECTED_SUBMIT, MCP_SELECTED_SUBMIT } from "./surface-policy";

type SelectedSubmitCommand = {
  transaction: VersionedTransaction;
  wallet: PublicKey;
  walletSignature: Uint8Array;
  permitInput: SelectedPermitInput;
  prepared?: VersionedTransaction;
};
type SelectedSubmitProfile = typeof APP_SELECTED_SUBMIT | typeof MCP_SELECTED_SUBMIT;

// Internal RPC stage only. The adapters must retain their runtime permit and
// structure checks, in their original order; this type is not authorization proof.
// Never rebuild the signed transaction or classify a send failure as unsent here.
export async function submitSelected(
  { transaction, wallet, walletSignature, permitInput: input, prepared }: SelectedSubmitCommand,
  profile: SelectedSubmitProfile,
) {
  const app = profile === APP_SELECTED_SUBMIT;
  const connection = rpcConnection();
  const [height, state] = await Promise.all([
    connection.getBlockHeight("confirmed"),
    app
      ? readSelectedPositionState(input.wallet, input.selection, connection, false, { displayPrices: false })
      : readSelectedPositionState(input.wallet, input.selection, connection),
  ]);
  if (height > input.lastValidBlockHeight) throw new Error("Transaction blockhash expired");
  if (app && state.inputKind === "native" && state.wsolBalance !== "0") {
    throw new Error("Native SOL input already has WSOL ATA balance, please handle separately to avoid using existing WSOL");
  }
  if (!state.ownsNft || state.paused || state.frozen || state.transferFee ||
    state.unsupportedExtensions.length || !state.sufficientSol ||
    state.positionMint !== input.selection.positionMint ||
    state.inputMint !== input.selection.inputMint || state.inputKind !== input.selection.inputKind ||
    state.liquidity !== input.startingLiquidity || state.rangeSide !== input.rangeSide ||
    state.balances.input !== input.startingBalances.input ||
    state.balances.a !== input.startingBalances.a || state.balances.b !== input.startingBalances.b) {
    throw new Error(app
      ? "Selected NFT, range, liquidity, or wallet balance has changed"
      : "Position, liquidity, or wallet balance has changed since preparation");
  }
  // Same signed message, with the original per-surface account-read policy.
  await simulateAndVerifySelectedTransaction({
    connection, transaction, wallet, state, requested: BigInt(input.requested),
    expectedLiquidity: BigInt(input.expectedLiquidity), sigVerify: true,
    prepared,
    ...(app ? { useStateSnapshot: true } : {}),
  });
  if (Date.now() >= input.expiresAt || await connection.getBlockHeight("confirmed") > input.lastValidBlockHeight) {
    throw new Error("Signed transaction expired before broadcast");
  }
  const expectedSignature = bs58.encode(walletSignature);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3,
  });
  if (signature !== expectedSignature) {
    throw new Error(app
      ? "Dedicated RPC returned transaction signature mismatch"
      : "RPC returned transaction signature mismatch");
  }
  invalidatePositionHistoryCache(input.selection.positionMint);
  return signature;
}

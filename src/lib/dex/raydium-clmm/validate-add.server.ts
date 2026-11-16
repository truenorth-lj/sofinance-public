import "@/lib/engine-host";
import "server-only";
import { readSelectedPositionState } from "@sofinance/engine/selected-state";
import { simulateAndVerifySelectedTransaction } from "@/lib/selected-simulation";
import { APP_SELECTED_SUBMIT, type ValidateSignedAdd } from "../add-submit";

/** Protocol admission and simulation only; the common sender retains broadcast ownership. */
export const validateRaydiumSignedAdd: ValidateSignedAdd = async (
  { transaction, wallet, permitInput: input, prepared }, connection, profile,
) => {
  const app = profile === APP_SELECTED_SUBMIT;
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
};

/**
 * Engine message when the connected wallet has a zero balance of the selected
 * token input (missing ATA or empty ATA). `readSelectedPositionState` throws
 * this only when allowEmptyInput is false, inputKind is "token", the mint is a
 * valid investable asset (no NFT / Token-2022 policy reason), and the ATA is
 * not frozen. Sibling of position_not_held: user wallet state, not a server
 * failure — answer 409 and keep it out of error monitoring.
 */
export const INPUT_ASSET_NOT_HELD_ENGINE_MESSAGE = "Wallet does not have the selected investable asset";
export const INPUT_ASSET_NOT_HELD_CODE = "input_asset_not_held";
export const INPUT_ASSET_NOT_HELD_MESSAGE =
  "Wallet does not have the selected input asset. Please pick another asset.";

export function isInputAssetNotHeldError(error: unknown): boolean {
  return error instanceof Error && error.message === INPUT_ASSET_NOT_HELD_ENGINE_MESSAGE;
}

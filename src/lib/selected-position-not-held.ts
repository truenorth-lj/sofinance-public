/**
 * Engine message when the connected wallet no longer holds the selected position NFT
 * (withdrawn, transferred, or a stale selection after switching wallets). This is user
 * state, not a server failure: answer 409 and keep it out of error monitoring.
 */
export const POSITION_NOT_HELD_MESSAGE = "Wallet does not currently hold this Raydium CLMM position NFT";
export const POSITION_NOT_HELD_CODE = "position_not_held";

export function isPositionNotHeldError(error: unknown): boolean {
  return error instanceof Error && error.message === POSITION_NOT_HELD_MESSAGE;
}

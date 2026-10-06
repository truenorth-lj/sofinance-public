export type AtomicStatus = "pending" | "expired" | "failed" | "success" | "manual-review";

export function mayStartAnotherAttempt(status: AtomicStatus | null) {
  return status === null || status === "expired" || status === "failed" || status === "success";
}

// Raydium increase_liquidity_v2: 8-byte discriminator followed by a little-endian u128 liquidity.
export function instructionLiquidity(data: Uint8Array) {
  if (data.length < 24) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(8, true) + (view.getBigUint64(16, true) << 64n);
}

export function confirmedAtomicSuccess(input: {
  signedByWallet: boolean;
  addedToExactPosition: boolean;
  ownsNft: boolean;
  startingLiquidity: string;
  expectedLiquidity: string;
  currentLiquidity: string;
  transactionLiquidity: bigint | null;
}) {
  return input.signedByWallet && input.addedToExactPosition && input.ownsNft &&
    BigInt(input.expectedLiquidity) > 0n &&
    input.transactionLiquidity === BigInt(input.expectedLiquidity) &&
    BigInt(input.currentLiquidity) >= BigInt(input.startingLiquidity) + BigInt(input.expectedLiquidity);
}

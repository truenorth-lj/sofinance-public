import "@/lib/engine-host";
import "server-only";
import { getOrcaPositionPerformance } from "@/lib/orca-positions";
import type { NativePositionReader } from "../position-read";
export { positionMintLooksLikeOrca as matchesOrcaPosition, readOrcaPositionRangeFacts as readOrcaRange } from "@/lib/orca-positions";
/** Retain this native transport's three-option call; Raydium history refresh does not apply here. */
export const readOrcaPerformance: NativePositionReader["performance"] = (positionMint, { wallet, maxSignatures, skipPricing }) =>
  getOrcaPositionPerformance(positionMint, { wallet, maxSignatures, skipPricing });
export { listOrcaPositions as listOrcaWalletPositions } from "@/lib/orca-positions";

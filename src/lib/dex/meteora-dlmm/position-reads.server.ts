import "@/lib/engine-host";
import "server-only";
import { getMeteoraPositionPerformance } from "@/lib/meteora-positions";
import type { NativePositionReader } from "../position-read";
export { positionAccountLooksLikeMeteora as matchesMeteoraPosition, readMeteoraPositionRangeFacts as readMeteoraRange } from "@/lib/meteora-positions";
/** Retain this native transport's three-option call; Raydium history refresh does not apply here. */
export const readMeteoraPerformance: NativePositionReader["performance"] = (positionMint, { wallet, maxSignatures, skipPricing }) =>
  getMeteoraPositionPerformance(positionMint, { wallet, maxSignatures, skipPricing });
export { listMeteoraPositions as listMeteoraWalletPositions } from "@/lib/meteora-positions";

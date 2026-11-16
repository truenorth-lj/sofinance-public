import { isRhcApr7dEnabled } from "@/lib/protocol-flags";
import type { PoolChain } from "./model";

/** Same chain-level read gate for browser cards and homepage SSR; operation flags are independent. */
const UNAVAILABLE_REASON: Readonly<Record<PoolChain, () => string | null>> = Object.freeze({
  solana: () => null,
  robinhood: () => isRhcApr7dEnabled() ? null : "No 7-day estimate for this pool yet.",
});
export function poolAprUnavailableReason(chain: PoolChain): string | null {
  return UNAVAILABLE_REASON[chain]();
}

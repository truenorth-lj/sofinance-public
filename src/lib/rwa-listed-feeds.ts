import { type DeployTarget, deployTarget, isMeteoraRwaListEnabled } from "./protocol-flags";
import { FEED_KEY, FEED_KEY_METEORA, type SolanaFeedKey } from "./rwa-store-types";

/**
 * The Solana feeds the pool list reads (`/api/rwa-pairs`, `/app/rwa-pairs`, homepage): the Raydium feed, plus the
 * Meteora DLMM scan feed while `METEORA_RWA_LIST_ENABLED` (and its scan) is on.
 */
export function listedSolanaFeedKeys(target: DeployTarget = deployTarget()): SolanaFeedKey[] {
  return isMeteoraRwaListEnabled(target) ? [FEED_KEY, FEED_KEY_METEORA] : [FEED_KEY];
}

import { FEED_KEY, FEED_KEY_METEORA, type SolanaFeedKey } from "./rwa-store-types";

/**
 * The Solana feeds the pool list reads (`/api/rwa-pairs`, `/app/rwa-pairs`, homepage): the Raydium feed and the
 * Meteora DLMM scan feed.
 */
export function listedSolanaFeedKeys(): SolanaFeedKey[] {
  return [FEED_KEY, FEED_KEY_METEORA];
}

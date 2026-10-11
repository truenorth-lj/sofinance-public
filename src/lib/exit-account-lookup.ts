/**
 * Which NFT token account can the Performance tab hand to the exit estimate for the position it is showing?
 *
 * `account` is the connected wallet's own NFT token account (it lets the server skip a rate-limited holder lookup).
 * `pending` is true only while that account is genuinely still being resolved; every terminal situation (no wallet, the
 * wallet does not hold this position, no investable asset so no selection can form, any read error) is
 * `pending: false` with no account, so the UI can say so instead of waiting forever.
 */
export type NftAccountLookup = { account: string | undefined; pending: boolean };

type LookupInput = {
  connected: boolean;
  /** Position NFT mint the Performance tab shows (the deep link wins over the wallet's default selection). */
  targetMint: string;
  discovery: { positions: { positionMint: string }[]; assets: { eligible: boolean }[] } | null;
  state: { positionMint: string; nftAta: string; ownsNft: boolean } | null;
  loadingDiscovery: boolean;
  loadingState: boolean;
  hasError: boolean;
};

export function resolveNftAccountLookup(input: LookupInput): NftAccountLookup {
  const { connected, targetMint, discovery, state } = input;
  const none = { account: undefined, pending: false };
  if (!targetMint) return none;
  if (state && state.positionMint === targetMint) return { account: state.ownsNft ? state.nftAta : undefined, pending: false };
  if (!connected || input.hasError) return none;
  if (input.loadingDiscovery || !discovery) return { account: undefined, pending: true };
  if (!discovery.positions.some((position) => position.positionMint === targetMint)) return none;
  if (!discovery.assets.some((asset) => asset.eligible)) return none;
  return { account: undefined, pending: true };
}

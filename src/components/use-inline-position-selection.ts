import { useState } from "react";

/** Minimum discovery/selection shape the inline pick needs. */
type DiscoveryLike = { positions: readonly { positionMint: string }[] } | null;
type SelectionLike = { positionMint: string } | null;

/**
 * Render-phase reconciliation of the inline (scanned) Solana position pick.
 *
 * Picks survive missing Add inputs, but never a wallet change or a position that
 * the current discovery no longer lists. The controller is reconciled here,
 * including the render before effects run — do not replace this with a
 * layout-effect-only reset, and do not use useLatest.
 */
export function useInlinePositionSelection({
  wallet,
  connected,
  discovery,
  selection,
  initialMint,
}: {
  wallet: string | null | undefined;
  connected: boolean;
  discovery: DiscoveryLike;
  selection: SelectionLike;
  initialMint: string;
}) {
  const [pickWallet, setPickWallet] = useState(wallet);
  const [inlinePick, setInlinePick] = useState<{ wallet: string; mint: string } | null>(null);
  if (pickWallet !== wallet) {
    setPickWallet(wallet);
    setInlinePick(null);
  }
  const ownedPick = pickWallet === wallet && inlinePick && inlinePick.wallet === wallet
    && discovery?.positions.some((item) => item.positionMint === inlinePick.mint) ? inlinePick : null;
  if (inlinePick && !ownedPick) setInlinePick(null);
  const inlineMint = ownedPick?.mint || selection?.positionMint
    || (discovery?.positions.some((item) => item.positionMint === initialMint) ? initialMint : discovery?.positions[0]?.positionMint) || "";
  const selectionAligned = Boolean(connected && wallet && pickWallet === wallet
    && selection?.positionMint === inlineMint);
  return { ownedPick, inlineMint, selectionAligned, setInlinePick };
}

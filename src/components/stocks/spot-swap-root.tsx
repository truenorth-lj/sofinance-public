"use client";

import { Providers } from "@/components/providers";
import type { StockBuyOption } from "@/lib/stock-market/public";
import { SpotSwapModal } from "./spot-swap-modal";

/**
 * Wallet providers (Terms gate, transaction notices) for the homepage Buy, loaded on the first Buy click and kept
 * mounted afterwards so a purchase's notice stays until the user dismisses it.
 */
export function SpotSwapRoot({ option, onClose }: { option: StockBuyOption | null; onClose: () => void }) {
  return <Providers>{option ? <SpotSwapModal key={option.underlying} option={option} onClose={onClose} /> : null}</Providers>;
}

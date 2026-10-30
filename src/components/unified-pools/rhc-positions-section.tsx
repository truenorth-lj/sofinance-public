"use client";

import type { RhcWallet } from "../rhc-univ4-open-panel";
import { RhcUniv4PositionsPanel } from "../rhc-univ4-positions-panel";

/**
 * "My positions" on `/app`, Robinhood Chain part: positions opened in this browser plus NFT numbers added by hand
 * (owner-checked by the server; the v4 PositionManager is not enumerable), with the existing simulated full close.
 * Rendered only while the nav's EVM wallet is connected (nav "EVM wallet" or a Robinhood Chain pool's Open position), so
 * Solana users see no wallet prompts for another chain here.
 */
export function RhcPositionsSection({ wallet, signingEnabled, refreshKey }: {
  wallet: RhcWallet | null; signingEnabled: boolean; refreshKey: number;
}) {
  if (!wallet) return null;
  return <div className="mt-6 border-t border-white/10 pt-5" data-testid="rhc-positions-section">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm font-semibold text-cream">Robinhood Chain</p>
      <p className="text-xs text-smoke" data-testid="rhc-wallet">{wallet.name}: {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}</p>
    </div>
    <RhcUniv4PositionsPanel wallet={wallet} signingEnabled={signingEnabled} refreshKey={refreshKey} />
  </div>;
}

"use client";

import { X } from "lucide-react";
import { RhcUniv4OpenPanel, type RhcPoolView, type RhcWallet } from "../rhc-univ4-open-panel";

/**
 * Robinhood Chain open flow as a dialog over the pool list (`/app/rwa-pairs`): MetaMask connects when it opens, and every
 * step is simulated before MetaMask asks to sign (`RhcUniv4OpenPanel`, unchanged). No Solana content here.
 */
export function RhcOpenDialog({ pool, wallet, signingEnabled, onWalletChange, onClose, onOpened }: {
  pool: RhcPoolView; wallet: RhcWallet | null; signingEnabled: boolean;
  onWalletChange: (wallet: RhcWallet) => void; onClose: () => void; onOpened?: (positionId: string) => void;
}) {
  return <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-labelledby="rhc-open-title">
    <button type="button" className="absolute inset-0 bg-black/70" aria-label="Close Robinhood Chain position" onClick={onClose} />
    <div className="relative z-10 max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-[20px] border border-white/12 bg-char p-5 text-cream sm:rounded-[28px] sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="rhc-open-title" className="text-base font-semibold">Open position · Robinhood Chain</h2>
          <p className="mt-1 text-xs leading-5 text-smoke">
            One Uniswap v4 transaction: swap the part you need, open the position and return any leftover. Every step is
            simulated before MetaMask asks you to sign. Closing is in My positions, with no SoFinance fee.
          </p>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg p-1 text-smoke hover:text-cream/90" aria-label="Close"><X className="h-4 w-4" /></button>
      </div>
      <RhcUniv4OpenPanel pool={pool} signingEnabled={signingEnabled} initialWallet={wallet} autoConnect showPositions={false}
        onWalletChange={onWalletChange} onOpened={onOpened} />
    </div>
  </div>;
}

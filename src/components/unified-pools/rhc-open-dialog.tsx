"use client";

import { X } from "lucide-react";
import { useEvmWalletConnection } from "../evm-wallet-connection";
import { RhcUniv4OpenPanel, type RhcPoolView } from "../rhc-univ4-open-panel";
import { RhcWrongNetworkPrompt } from "./rhc-wrong-network-prompt";

/**
 * Robinhood Chain open flow as a dialog over the pool list (`/app/rwa-pairs`). It uses the nav's EVM wallet
 * (`useEvmWalletConnection`); with none connected it asks to connect when it opens, and that connects the same shared
 * session the nav shows. While that wallet is on another network the dialog shows a switch prompt instead of the open
 * panel. Every step is simulated before MetaMask asks to sign (`RhcUniv4OpenPanel`). No Solana content here.
 */
export function RhcOpenDialog({ pool, signingEnabled, onClose, onOpened }: {
  pool: RhcPoolView; signingEnabled: boolean; onClose: () => void; onOpened?: (positionId: string) => void;
}) {
  const evm = useEvmWalletConnection();
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
      {evm.status === "restoring" ? <p className="mt-4 text-xs text-smoke" role="status">Checking your EVM wallet…</p>
        : evm.wrongNetwork ? <RhcWrongNetworkPrompt purpose="open this position" /> : <RhcUniv4OpenPanel pool={pool} signingEnabled={signingEnabled} initialWallet={evm.wallet} connectWallet={evm.connect}
        autoConnect={!evm.wallet} showPositions={false} onOpened={onOpened} />}
    </div>
  </div>;
}

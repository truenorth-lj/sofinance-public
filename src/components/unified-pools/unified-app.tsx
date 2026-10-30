"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { SelectedApp } from "../selected-app";
import { RhcUniv4OpenPanel, type RhcPoolView, type RhcWallet } from "../rhc-univ4-open-panel";
import { RhcPositionsSection } from "./rhc-positions-section";
import { UnifiedPoolsPanel, type UnifiedPoolFlags } from "./unified-pools-panel";

type SelectedAppProps = Parameters<typeof SelectedApp>[0];

/**
 * `/app`: the Solana positions manager (`SelectedApp`) with the unified Solana + Robinhood Chain pool list and the
 * Robinhood Chain positions added to "My positions". The MetaMask account is shared between the Robinhood Chain open
 * dialog and the positions section, so connecting in one shows up in the other.
 */
export function UnifiedApp({ selected, flags, rhcSigningEnabled, deepLinkPool }: {
  selected: SelectedAppProps;
  flags: UnifiedPoolFlags;
  rhcSigningEnabled: boolean;
  deepLinkPool?: string;
}) {
  const [evmWallet, setEvmWallet] = useState<RhcWallet | null>(null);
  const [rhcPositionsKey, setRhcPositionsKey] = useState(0);
  const [rhcOpen, setRhcOpen] = useState<RhcPoolView | null>(null);

  return <>
    <SelectedApp {...selected} solanaToolsHidden={rhcOpen !== null}
      extraPositions={flags.rhc ? <RhcPositionsSection wallet={evmWallet} onConnected={setEvmWallet} signingEnabled={rhcSigningEnabled} refreshKey={rhcPositionsKey} /> : undefined}
      poolsSection={<UnifiedPoolsPanel flags={flags} deepLinkPool={deepLinkPool} onOpenRhc={({ pool }) => setRhcOpen(pool)} />} />
    {rhcOpen && <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-labelledby="rhc-open-title">
      <button type="button" className="absolute inset-0 bg-black/70" aria-label="Close Robinhood Chain position" onClick={() => setRhcOpen(null)} />
      <div className="relative z-10 max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-[20px] border border-white/12 bg-char p-5 text-cream sm:rounded-[28px] sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="rhc-open-title" className="text-base font-semibold">Open position · Robinhood Chain</h2>
            <p className="mt-1 text-xs leading-5 text-smoke">
              One Uniswap v4 transaction: swap the part you need, open the position and return any leftover. Every step is
              simulated before MetaMask asks you to sign. Closing is in My positions, with no SoFinance fee.
            </p>
          </div>
          <button type="button" onClick={() => setRhcOpen(null)} className="rounded-lg p-1 text-smoke hover:text-cream/90" aria-label="Close"><X className="h-4 w-4" /></button>
        </div>
        <RhcUniv4OpenPanel pool={rhcOpen} signingEnabled={rhcSigningEnabled} initialWallet={evmWallet} autoConnect showPositions={false}
          onWalletChange={setEvmWallet} onOpened={() => setRhcPositionsKey((key) => key + 1)} />
      </div>
    </div>}
  </>;
}

"use client";

import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { connectRhcWallet, type RhcWallet } from "../rhc-univ4-open-panel";
import { RhcUniv4PositionsPanel } from "../rhc-univ4-positions-panel";

/**
 * "My positions" on `/app`, Robinhood Chain part: positions opened in this browser plus NFT numbers added by hand
 * (owner-checked by the server; the v4 PositionManager is not enumerable), with the existing simulated full close.
 */
export function RhcPositionsSection({ wallet, onConnected, signingEnabled, refreshKey }: {
  wallet: RhcWallet | null; onConnected: (wallet: RhcWallet) => void; signingEnabled: boolean; refreshKey: number;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = async () => {
    setBusy(true); setError(null);
    try { onConnected(await connectRhcWallet()); } catch (e) { setError(e instanceof Error ? e.message : "Wallet connection failed"); } finally { setBusy(false); }
  };
  return <div className="mt-6 border-t border-white/10 pt-5" data-testid="rhc-positions-section">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm font-semibold text-cream">Robinhood Chain</p>
      {wallet
        ? <p className="text-xs text-smoke" data-testid="rhc-wallet">{wallet.name}: {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}</p>
        : <button type="button" onClick={() => void connect()} disabled={busy}
            className="inline-flex items-center gap-2 rounded-full border border-white/25 px-3 py-1.5 text-xs font-semibold text-cream disabled:opacity-40">
            {busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}Connect MetaMask
          </button>}
    </div>
    {!wallet && <p className="mt-1 text-xs text-smoke">Connect MetaMask to see your Robinhood Chain (Uniswap v4) positions.</p>}
    {error && <p role="alert" className="mt-2 text-xs text-red-200">{error}</p>}
    {wallet && <RhcUniv4PositionsPanel wallet={wallet} signingEnabled={signingEnabled} refreshKey={refreshKey} />}
  </div>;
}

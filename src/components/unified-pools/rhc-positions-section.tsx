"use client";

import { useState, useSyncExternalStore } from "react";
import { LoaderCircle } from "lucide-react";
import { connectRhcWallet, type RhcWallet } from "../rhc-univ4-open-panel";
import { RhcUniv4PositionsPanel } from "../rhc-univ4-positions-panel";
import { hasAnyTrackedPositions } from "@/lib/rhc-wallet/exit-execute";

const subscribeStorage = (onChange: () => void) => {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
};

/**
 * "My positions" on `/app`, Robinhood Chain part: positions opened in this browser plus NFT numbers added by hand
 * (owner-checked by the server; the v4 PositionManager is not enumerable), with the existing simulated full close.
 * The full section shows only when MetaMask is connected or this browser has a saved Robinhood Chain position;
 * otherwise it is one quiet line at the bottom of the panel, so Solana users don't see wallet prompts for another chain.
 */
export function RhcPositionsSection({ wallet, onConnected, signingEnabled, refreshKey }: {
  wallet: RhcWallet | null; onConnected: (wallet: RhcWallet) => void; signingEnabled: boolean; refreshKey: number;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Re-read on every render (refreshKey changes after an open in this tab); `storage` events cover other tabs.
  const hasSaved = useSyncExternalStore(subscribeStorage, () => hasAnyTrackedPositions(), () => false);
  const connect = async () => {
    setBusy(true); setError(null);
    try { onConnected(await connectRhcWallet()); } catch (e) { setError(e instanceof Error ? e.message : "Wallet connection failed"); } finally { setBusy(false); }
  };
  if (!wallet && !hasSaved) {
    return <div className="mt-6 border-t border-white/10 pt-4" data-testid="rhc-positions-hint">
      <p className="text-xs text-smoke">
        Robinhood Chain positions →{" "}
        <button type="button" onClick={() => void connect()} disabled={busy}
          className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-cream/90 disabled:opacity-40">
          {busy && <LoaderCircle className="h-3 w-3 animate-spin" />}connect MetaMask
        </button>
      </p>
      {error && <p role="alert" className="mt-2 text-xs text-red-200">{error}</p>}
    </div>;
  }
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
    {!wallet && <p className="mt-1 text-xs text-smoke">You opened a Robinhood Chain position in this browser. Connect MetaMask to see it.</p>}
    {error && <p role="alert" className="mt-2 text-xs text-red-200">{error}</p>}
    {wallet && <RhcUniv4PositionsPanel wallet={wallet} signingEnabled={signingEnabled} refreshKey={refreshKey} />}
  </div>;
}

"use client";

import { useState } from "react";
import { InkHero, InkNav, InkShell } from "../ink";
import type { RhcPoolView, RhcWallet } from "../rhc-univ4-open-panel";
import { useWalletConnection } from "../wallet-connection";
import { RhcOpenDialog } from "./rhc-open-dialog";
import { UnifiedPoolsPanel, type UnifiedPoolFlags } from "./unified-pools-panel";

/**
 * `/app/rwa-pairs`, the pools page: Solana and Robinhood Chain pools in one list (`UnifiedPoolsPanel`). Opening a Solana
 * pool connects the Solana wallet and opens Create position; opening a Robinhood Chain pool opens its MetaMask dialog.
 * `?openPool=<id>` (also where `/app/rhc` and old `/app?openPool=` links land) opens that pool once it is listed.
 */
export function PoolsPage({ flags, rhcSigningEnabled, deepLinkPool }: {
  flags: UnifiedPoolFlags; rhcSigningEnabled: boolean; deepLinkPool?: string;
}) {
  const { address, connected, connect, disconnect } = useWalletConnection();
  const [evmWallet, setEvmWallet] = useState<RhcWallet | null>(null);
  const [rhcOpen, setRhcOpen] = useState<RhcPoolView | null>(null);
  return <InkShell>
    <InkNav wallet={address} connected={connected} onConnect={connect} onDisconnect={disconnect} />
    <InkHero label="RWA pairs" title="RWA pairs on Solana and Robinhood Chain">
      <p>
        Same-asset RWA pools (for example SPCXx/SPCX) and the curated USDC/USDT pool, on Solana and Robinhood Chain, in one list.
        Create a position from any wallet asset: we swap into the pool tokens as needed and open the position in one transaction.
      </p>
    </InkHero>
    <UnifiedPoolsPanel flags={flags} deepLinkPool={deepLinkPool} onOpenRhc={({ pool }) => setRhcOpen(pool)} />
    {rhcOpen && <RhcOpenDialog pool={rhcOpen} wallet={evmWallet} signingEnabled={rhcSigningEnabled}
      onWalletChange={setEvmWallet} onClose={() => setRhcOpen(null)} />}
  </InkShell>;
}

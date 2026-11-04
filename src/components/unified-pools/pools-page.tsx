"use client";

import { useState } from "react";
import { InkFooter, InkHero, InkNav, InkShell } from "../ink";
import type { RhcPoolView } from "../rhc-univ4-open-panel";
import { useWalletConnection } from "../wallet-connection";
import { RhcOpenDialog } from "./rhc-open-dialog";
import { UnifiedPoolsPanel, type UnifiedPoolFlags } from "./unified-pools-panel";

/**
 * `/app/rwa-pairs`, the pools page: Solana and Robinhood Chain pools in one list (`UnifiedPoolsPanel`). The nav has two
 * independent wallets (Solana, EVM). Opening a Solana pool uses the Solana wallet and opens Create position; opening a
 * Robinhood Chain pool opens its dialog on the nav's EVM wallet (asking to connect it when none is connected).
 * `?openPool=<id>` (also where `/app/rhc` and old `/app?openPool=` links land) opens that pool once it is listed.
 */
export function PoolsPage({ flags, rhcSigningEnabled, deepLinkPool }: {
  flags: UnifiedPoolFlags; rhcSigningEnabled: boolean; deepLinkPool?: string;
}) {
  const { address, connected, connect, disconnect } = useWalletConnection();
  const [rhcOpen, setRhcOpen] = useState<RhcPoolView | null>(null);
  return <InkShell>
    <InkNav wallet={address} connected={connected} onConnect={connect} onDisconnect={disconnect} />
    <InkHero label="Pools" title="RWA pairs on Solana and Robinhood Chain" />
    <UnifiedPoolsPanel flags={flags} deepLinkPool={deepLinkPool} onOpenRhc={({ pool }) => setRhcOpen(pool)} />
    {rhcOpen && <RhcOpenDialog pool={rhcOpen} signingEnabled={rhcSigningEnabled} onClose={() => setRhcOpen(null)} />}
    <InkFooter />
  </InkShell>;
}

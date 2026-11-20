"use client";

import { useState } from "react";
import { InkShell } from "../ink";
import { SiteFooter } from "../site-footer";
import { SiteHeader } from "../site-header";
import type { RhcPoolView } from "../rhc-univ4-open-panel";
import { useWalletConnection } from "../wallet-connection";
import { RhcOpenDialog } from "./rhc-open-dialog";
import { PUBLIC_POOLS_SSR_HEADING } from "@/lib/public-pools-table";
import { UnifiedPoolsPanel, type UnifiedPoolFlags } from "./unified-pools-panel";

/** Visible page title on /app/rwa-pairs; the only h1 on that page. */
export const POOLS_PAGE_TITLE = "Pools";
/** Subline under the title (no card). Same wording as the crawler-table heading. */
export const POOLS_PAGE_SUBLINE = PUBLIC_POOLS_SSR_HEADING;

/**
 * `/app/rwa-pairs`, the pools page: Solana and Robinhood Chain pools in one list (`UnifiedPoolsPanel`). The nav has two
 * independent wallets (Solana, EVM). Opening a Solana pool uses the Solana wallet and opens Create position; opening a
 * Robinhood Chain pool opens its dialog on the nav's EVM wallet (asking to connect it when none is connected).
 * `?openPool=<id>` (also where `/app/rhc` and old `/app?openPool=` links land) opens that pool once it is listed.
 * `?calc=<id>` opens the share calculator for that pool.
 */
export function PoolsPage({ flags, rhcSigningEnabled, deepLinkPool, deepLinkCalc, initialQuery }: {
  flags: UnifiedPoolFlags; rhcSigningEnabled: boolean; deepLinkPool?: string; deepLinkCalc?: string; initialQuery?: string;
}) {
  const { address, connected, restoring, connect, disconnect } = useWalletConnection();
  const [rhcOpen, setRhcOpen] = useState<RhcPoolView | null>(null);
  return <InkShell>
    <SiteHeader variant="app" wallet={address} connected={connected} restoring={restoring} onConnect={connect} onDisconnect={disconnect} />
    <div className="mt-5 px-1">
      <h1 className="text-xl font-semibold text-cream sm:text-2xl">{POOLS_PAGE_TITLE}</h1>
      <p className="mt-1 text-sm text-smoke">{POOLS_PAGE_SUBLINE}</p>
    </div>
    <UnifiedPoolsPanel flags={flags} deepLinkPool={deepLinkPool} deepLinkCalc={deepLinkCalc} initialQuery={initialQuery} onOpenRhc={({ pool }) => setRhcOpen(pool)} />
    {rhcOpen && <RhcOpenDialog pool={rhcOpen} signingEnabled={rhcSigningEnabled} onClose={() => setRhcOpen(null)} />}
    <SiteFooter variant="app" />
  </InkShell>;
}

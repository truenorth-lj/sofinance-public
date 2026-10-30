"use client";

import { useEffect, useState } from "react";
import { SelectedApp } from "../selected-app";
import { restoreRhcWallet, type RhcWallet } from "../rhc-univ4-open-panel";
import { RhcPositionsSection } from "./rhc-positions-section";
import type { UnifiedPoolFlags } from "./unified-pools-panel";

type SelectedAppProps = Parameters<typeof SelectedApp>[0];

/**
 * `/app` (Positions): only "My positions" and the tools for the selected Solana position. The pool list lives on
 * `/app/rwa-pairs`. Robinhood Chain positions join "My positions" only while MetaMask is connected to this site: the
 * account MetaMask already shares (`eth_accounts`, no prompt) is picked up on load; nothing shows without it.
 */
export function UnifiedApp({ selected, flags, rhcSigningEnabled }: {
  selected: SelectedAppProps;
  flags: UnifiedPoolFlags;
  rhcSigningEnabled: boolean;
}) {
  const [evmWallet, setEvmWallet] = useState<RhcWallet | null>(null);
  useEffect(() => {
    if (!flags.rhc) return;
    let cancelled = false;
    restoreRhcWallet().then((wallet) => { if (!cancelled && wallet) setEvmWallet(wallet); }, () => {});
    return () => { cancelled = true; };
  }, [flags.rhc]);

  return <SelectedApp {...selected}
    extraPositions={flags.rhc && evmWallet ? <RhcPositionsSection wallet={evmWallet} signingEnabled={rhcSigningEnabled} refreshKey={0} /> : undefined} />;
}

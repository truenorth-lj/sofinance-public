"use client";

import { useCallback, useState } from "react";
import { useEvmWalletConnection } from "../evm-wallet-connection";
import { SelectedApp } from "../selected-app";
import { RhcPositionsSection } from "./rhc-positions-section";
import type { UnifiedPoolFlags } from "./unified-pools-panel";

type SelectedAppProps = Parameters<typeof SelectedApp>[0];

/**
 * `/app` (Positions): only "My positions" and the tools for the selected Solana position. The pool list lives on
 * `/app/rwa-pairs`. Robinhood Chain positions join "My positions" only while the nav's EVM wallet is connected (restored on
 * load from the account the wallet already shares, `eth_accounts`, no prompt); nothing shows without it.
 */
export function UnifiedApp({ selected, flags, rhcSigningEnabled }: {
  selected: SelectedAppProps;
  flags: UnifiedPoolFlags;
  rhcSigningEnabled: boolean;
}) {
  const { wallet: evmWallet } = useEvmWalletConnection();
  // Shared refresh counter: "Rescan wallet" bumps it, and the Robinhood Chain panel rescans (fresh=1) whenever it changes.
  // It belongs to one EVM address, so a newly connected wallet starts at 0 (first load keeps the server's cached scan).
  const address = evmWallet?.address ?? "";
  const [rescans, setRescans] = useState({ address: "", count: 0 });
  const rescanKey = rescans.address === address ? rescans.count : 0;
  const rescan = useCallback(() => setRescans((current) =>
    ({ address, count: (current.address === address ? current.count : 0) + 1 })), [address]);

  const rhc = flags.rhc && evmWallet;
  return <SelectedApp {...selected}
    onRescan={rhc ? rescan : undefined}
    extraPositions={rhc ? <RhcPositionsSection wallet={evmWallet} signingEnabled={rhcSigningEnabled} refreshKey={rescanKey} /> : undefined} />;
}

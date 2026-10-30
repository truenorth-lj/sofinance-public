"use client";

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

  return <SelectedApp {...selected}
    extraPositions={flags.rhc && evmWallet ? <RhcPositionsSection wallet={evmWallet} signingEnabled={rhcSigningEnabled} refreshKey={0} /> : undefined} />;
}

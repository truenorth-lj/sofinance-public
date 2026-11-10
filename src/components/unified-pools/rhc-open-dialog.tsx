"use client";

import { useEvmWalletConnection } from "../evm-wallet-connection";
import { OpenPositionChrome } from "../open-position/open-position-chrome";
import { RhcUniv4OpenPanel, type RhcPoolView } from "../rhc-univ4-open-panel";
import { RhcWrongNetworkPrompt } from "./rhc-wrong-network-prompt";

/**
 * Robinhood Chain open flow as a dialog over the pool list (`/app/rwa-pairs`). It uses the nav's EVM wallet
 * (`useEvmWalletConnection`); with none connected it asks to connect when it opens, and that connects the same shared
 * session the nav shows. While that wallet is on another network the dialog shows a switch prompt instead of the open
 * panel. Every step is simulated before MetaMask asks to sign (`RhcUniv4OpenPanel`). No Solana content here.
 * Chrome matches Raydium's Create position sheet (`OpenPositionChrome`).
 */
export function RhcOpenDialog({ pool, signingEnabled, onClose, onOpened }: {
  pool: RhcPoolView; signingEnabled: boolean; onClose: () => void; onOpened?: (positionId: string) => void;
}) {
  const evm = useEvmWalletConnection();
  return <OpenPositionChrome
    labelledBy="rhc-open-title"
    subtitle={pool.token0?.symbol && pool.token1?.symbol ? `${pool.token0.symbol}/${pool.token1.symbol} · Robinhood Chain` : "Robinhood Chain"}
    explainer="One Uniswap v4 transaction: swap the part you need, open the position and return any leftover. Every step is simulated before MetaMask asks you to sign. Closing is in My positions, with no SoFinance fee."
    closeAriaLabel="Close Robinhood Chain position"
    onClose={onClose}
    wide
  >
    {evm.status === "restoring" ? <p className="mt-4 text-xs text-smoke" role="status">Checking your EVM wallet…</p>
      : evm.wrongNetwork ? <RhcWrongNetworkPrompt purpose="open this position" /> : <RhcUniv4OpenPanel pool={pool} signingEnabled={signingEnabled} initialWallet={evm.wallet} connectWallet={evm.connect}
      autoConnect={!evm.wallet} showPositions={false} onOpened={onOpened} />}
  </OpenPositionChrome>;
}

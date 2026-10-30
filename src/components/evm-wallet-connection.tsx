"use client";

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { isRhcUniv4TradingEnabled } from "@/lib/protocol-flags";
import { RHC_CHAIN_ID } from "@/lib/rhc-wallet/eip1193";
import { createEvmSession, type EvmSession, type EvmSessionState, type EvmWallet } from "@/lib/rhc-wallet/evm-session";

/**
 * The app-wide EVM wallet (Robinhood Chain), next to the Solana `useWalletConnection`. The two never share state:
 * connecting or disconnecting one leaves the other untouched. Off (no button, no discovery) wherever
 * `RHC_UNIV4_TRADING_ENABLED` is off.
 */
export type EvmWalletConnection = EvmSessionState & {
  enabled: boolean;
  /** Connected, but the wallet is not on Robinhood Chain (4663): RHC sections show a switch prompt instead. */
  wrongNetwork: boolean;
  /** Goes through the "Before you connect" terms step (`TermsGate`) like the Solana connect. */
  connect: () => Promise<EvmWallet>;
  disconnect: () => void;
  dismissError: () => void;
  /** `ensureRobinhoodChain`: switch (or add, then switch) to Robinhood Chain. */
  switchNetwork: () => Promise<void>;
};

/** Exported for `TermsGate`, which re-provides it with a terms-gated `connect`. */
export const EvmWalletContext = createContext<EvmWalletConnection | null>(null);

export function EvmWalletProvider({ children, enabled = isRhcUniv4TradingEnabled(), session: injected }: {
  children?: ReactNode; enabled?: boolean;
  /** Tests inject a session with mock wallets. */
  session?: EvmSession;
}) {
  const [session] = useState(() => injected ?? createEvmSession());
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  // "restoring" until the first silent restore settles, so a dialog opened on load (deep link) waits for the restored
  // wallet instead of prompting for one.
  const [restored, setRestored] = useState(!enabled);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void session.restore().finally(() => { if (live) setRestored(true); });
    return () => { live = false; };
  }, [enabled, session]);
  const status = !restored && state.status === "idle" ? "restoring" : state.status;
  const value = useMemo<EvmWalletConnection>(() => ({
    ...state, status, enabled, wrongNetwork: Boolean(state.wallet) && state.chainId !== RHC_CHAIN_ID,
    connect: session.connect, disconnect: session.disconnect, dismissError: session.dismissError, switchNetwork: session.switchNetwork,
  }), [state, status, enabled, session]);
  return <EvmWalletContext.Provider value={value}>{children}</EvmWalletContext.Provider>;
}

export function useEvmWalletConnection(): EvmWalletConnection {
  const connection = useContext(EvmWalletContext);
  if (!connection) throw new Error("EVM wallet provider is missing");
  return connection;
}

/** For shared chrome (InkNav) that also renders outside the app providers (docs, blog, terms). */
export function useOptionalEvmWalletConnection(): EvmWalletConnection | null {
  return useContext(EvmWalletContext);
}

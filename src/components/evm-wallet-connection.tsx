"use client";

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { isRhcUniv4TradingEnabled } from "@/lib/protocol-flags";
import { createEvmSession, type EvmSession, type EvmSessionState, type EvmWallet } from "@/lib/rhc-wallet/evm-session";

/**
 * The app-wide EVM wallet (Robinhood Chain), next to the Solana `useWalletConnection`. The two never share state:
 * connecting or disconnecting one leaves the other untouched. Off (no button, no discovery) wherever
 * `RHC_UNIV4_TRADING_ENABLED` is off.
 */
export type EvmWalletConnection = EvmSessionState & {
  enabled: boolean;
  connect: () => Promise<EvmWallet>;
  disconnect: () => void;
  dismissError: () => void;
};

const EvmWalletContext = createContext<EvmWalletConnection | null>(null);

export function EvmWalletProvider({ children, enabled = isRhcUniv4TradingEnabled(), session: injected }: {
  children?: ReactNode; enabled?: boolean;
  /** Tests inject a session with mock wallets. */
  session?: EvmSession;
}) {
  const [session] = useState(() => injected ?? createEvmSession());
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  useEffect(() => { if (enabled) void session.restore(); }, [enabled, session]);
  const value = useMemo<EvmWalletConnection>(() => ({
    ...state, enabled, connect: session.connect, disconnect: session.disconnect, dismissError: session.dismissError,
  }), [state, enabled, session]);
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

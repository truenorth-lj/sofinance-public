"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { isRhcUniv4TradingEnabled } from "@/lib/protocol-flags";
import { RHC_CHAIN_ID } from "@/lib/rhc-wallet/eip1193";
import { createEvmSession, type EvmSession, type EvmSessionState, type EvmWallet } from "@/lib/rhc-wallet/evm-session";
import { captureGrowthEvent } from "@/lib/analytics/client";
import { GROWTH_EVENTS } from "@/lib/analytics/events";
import { walletConnectContext } from "@/lib/analytics/wallet-connect";
import {
  captureWalletConnectFailed,
  captureWalletConnectStarted,
  noteWalletConnectSucceeded,
  openWalletConnectSession,
} from "@/lib/analytics/wallet-connect-session";

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
  const value = useMemo<EvmWalletConnection>(() => {
    const connect = async () => {
      openWalletConnectSession({ chain: "rhc", wallet_name: "EVM wallet" });
      captureWalletConnectStarted({ wallet_name: "EVM wallet", chain: "rhc" });
      try {
        const wallet = await session.connect();
        noteWalletConnectSucceeded();
        return wallet;
      } catch (error) {
        captureWalletConnectFailed(error, { chain: "rhc" });
        throw error;
      }
    };
    return {
      ...state, status, enabled, wrongNetwork: Boolean(state.wallet) && state.chainId !== RHC_CHAIN_ID,
      connect, disconnect: session.disconnect, dismissError: session.dismissError, switchNetwork: session.switchNetwork,
    };
  }, [state, status, enabled, session]);
  return <EvmWalletContext.Provider value={value}>
    <EvmWalletGrowthAnalytics address={state.wallet?.address} name={state.wallet?.name} status={status} />
    {children}
  </EvmWalletContext.Provider>;
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

/** Auto-reconnect (restore) also records wallet_connected, without sending the EVM address. */
function EvmWalletGrowthAnalytics({ address, name, status }: { address?: string; name?: string; status: EvmSessionState["status"] }) {
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (status !== "connected" || !address || !name) {
      if (!address) last.current = null;
      return;
    }
    if (last.current === address) return;
    last.current = address;
    noteWalletConnectSucceeded();
    captureGrowthEvent(GROWTH_EVENTS.walletConnected, walletConnectContext({ wallet_name: name, chain: "rhc" }));
  }, [address, name, status]);
  return null;
}

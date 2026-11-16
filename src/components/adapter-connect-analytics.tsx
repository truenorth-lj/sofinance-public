"use client";

import { useEffect, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import {
  captureWalletConnectAbandoned,
  captureWalletConnectFailed,
  captureWalletConnectStarted,
} from "@/lib/analytics/wallet-connect-session";

type AdapterEvents = { name?: string; on?: (event: string, fn: (error: unknown) => void) => void; off?: (event: string, fn: (error: unknown) => void) => void };

/** Translates the wallet-adapter modal and adapter errors into our PostHog connect funnel. */
export function AdapterConnectAnalytics() {
  const { visible } = useWalletModal();
  const { wallet, connected, connecting } = useWallet();
  const wasVisible = useRef(false);
  const adapter = (wallet?.adapter ?? null) as AdapterEvents | null;
  const walletName = adapter?.name;

  useEffect(() => {
    if (walletName && (connecting || visible) && !connected) {
      captureWalletConnectStarted({ wallet_name: walletName, chain: "solana" });
    }
  }, [walletName, connecting, visible, connected]);

  useEffect(() => {
    if (!adapter?.on) return;
    const onError = (error: unknown) => captureWalletConnectFailed(error, { wallet_name: adapter.name, chain: "solana" });
    adapter.on("error", onError);
    return () => adapter.off?.("error", onError);
  }, [adapter]);

  useEffect(() => {
    if (wasVisible.current && !visible && !connected) captureWalletConnectAbandoned();
    wasVisible.current = visible;
  }, [visible, connected]);

  return null;
}

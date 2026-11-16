"use client";

import { useEffect, useRef } from "react";
import { captureWalletConnected, captureWalletDisconnected } from "@/lib/analytics/client";
import { noteWalletConnectSucceeded } from "@/lib/analytics/wallet-connect-session";
import { walletConnectContext, type WalletConnectChain } from "@/lib/analytics/wallet-connect";
import { useWalletConnection } from "./wallet-connection";

export function WalletGrowthAnalytics({ walletName, chain = "solana" }: {
  walletName?: string;
  chain?: WalletConnectChain;
}) {
  const { connected, address } = useWalletConnection();
  const last = useRef<string | null>(null);

  useEffect(() => {
    if (!connected || !address) {
      if (last.current) captureWalletDisconnected();
      last.current = null;
      return;
    }
    if (last.current === address) return;
    last.current = address;
    noteWalletConnectSucceeded();
    void captureWalletConnected(address, walletConnectContext({ wallet_name: walletName, chain }));
  }, [connected, address, walletName, chain]);

  return null;
}

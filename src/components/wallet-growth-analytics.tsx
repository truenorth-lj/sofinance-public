"use client";

import { useEffect, useRef } from "react";
import { captureWalletConnected, captureWalletDisconnected } from "@/lib/analytics/client";
import { useWalletConnection } from "./wallet-connection";

export function WalletGrowthAnalytics() {
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
    void captureWalletConnected(address);
  }, [connected, address]);

  return null;
}

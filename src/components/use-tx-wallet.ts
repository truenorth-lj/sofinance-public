"use client";

import { useMemo } from "react";
import type { TxWallet } from "@/lib/tx-pipeline";
import { useWalletConnection } from "./wallet-connection";

/**
 * The connected wallet as the transaction pipeline expects it, or null when
 * no address is connected. Shared by the registry, selected, spot-swap, and
 * sign-page flows (they previously inlined the same useMemo).
 */
export function useTxWallet(): TxWallet | null {
  const { address: wallet, signTransaction, signAndSendTransaction } = useWalletConnection();
  return useMemo(
    () => (wallet ? { address: wallet, signTransaction, signAndSendTransaction } : null),
    [wallet, signTransaction, signAndSendTransaction],
  );
}

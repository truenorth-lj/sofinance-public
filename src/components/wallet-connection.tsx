"use client";

import { createContext, useContext } from "react";
import type { VersionedTransaction } from "@solana/web3.js";

export type WalletConnection = {
  address?: string;
  connected: boolean;
  /** The provider is initializing or restoring/connecting a session; absence of an address is not final yet. */
  restoring?: boolean;
  /** Restoring the remembered wallet failed or timed out (e.g. a locked extension); show a retry instead of waiting. */
  restoreStalled?: boolean;
  connect: () => void;
  disconnect: () => void;
  isMobile: boolean;
  walletsCount: number;
  connectionError: string;
  signTransaction: (transaction: VersionedTransaction) => Promise<VersionedTransaction>;
  /**
   * Present when the wallet can broadcast for us (Wallet Standard `solana:signAndSendTransaction`,
   * Phantom's preferred path). Returns the base58 signature. Absent: sign, then we send once.
   */
  signAndSendTransaction?: (transaction: VersionedTransaction) => Promise<string>;
  signAllTransactions?: (transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>;
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
};

/** SSR / pre-AppKit value: pending, so the Connect button stays loading until the real session is known. */
export const DISCONNECTED_RESTORING_WALLET: WalletConnection = {
  connected: false,
  restoring: true,
  connect: () => {},
  disconnect: () => {},
  isMobile: false,
  walletsCount: 0,
  connectionError: "",
  signTransaction: async () => {
    throw new Error("Wallet is not connected");
  },
};

export const WalletConnectionContext = createContext<WalletConnection | null>(null);

export function useWalletConnection(): WalletConnection {
  const connection = useContext(WalletConnectionContext);
  if (!connection) throw new Error("Wallet connection provider is missing");
  return connection;
}

export function useOptionalWalletConnection(): WalletConnection | null {
  return useContext(WalletConnectionContext);
}

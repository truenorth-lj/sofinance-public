"use client";

import { createContext, useContext } from "react";
import type { VersionedTransaction } from "@solana/web3.js";

export type WalletConnection = {
  address?: string;
  connected: boolean;
  connect: () => void;
  disconnect: () => void;
  isMobile: boolean;
  walletsCount: number;
  connectionError: string;
  signTransaction: (transaction: VersionedTransaction) => Promise<VersionedTransaction>;
};

export const WalletConnectionContext = createContext<WalletConnection | null>(null);

export function useWalletConnection(): WalletConnection {
  const connection = useContext(WalletConnectionContext);
  if (!connection) throw new Error("Wallet connection provider is missing");
  return connection;
}

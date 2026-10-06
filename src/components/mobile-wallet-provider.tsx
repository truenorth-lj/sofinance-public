"use client";

import { SolanaAdapter } from "@reown/appkit-adapter-solana/react";
import { solana } from "@reown/appkit/networks";
import { createAppKit, useAppKitAccount, useDisconnect } from "@reown/appkit/react";
import { useAppKitProvider } from "@reown/appkit/react";
import type { VersionedTransaction } from "@solana/web3.js";
import { useAppKitWallet } from "@reown/appkit-wallet-button/react";
import { useState } from "react";
import { WalletConnectionContext } from "./wallet-connection";

const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID?.trim();

if (typeof window !== "undefined" && projectId) {
  createAppKit({
    adapters: [new SolanaAdapter({ wallets: [] })],
    networks: [solana],
    defaultNetwork: solana,
    projectId,
    metadata: {
      name: "SoFinance",
      description: "Read-only preflight specified Raydium position",
      url: window.location.origin,
      icons: [],
    },
    features: { analytics: false, email: false, socials: [] },
    enableWallets: false,
  });
}

export function MobileWalletProvider({ children }: { children: React.ReactNode }) {
  const account = useAppKitAccount({ namespace: "solana" });
  const { walletProvider } = useAppKitProvider<{ signTransaction?: (transaction: VersionedTransaction) => Promise<VersionedTransaction> }>("solana");
  const { disconnect } = useDisconnect();
  const [connectionError, setConnectionError] = useState("");
  const { connect } = useAppKitWallet({
    namespace: "solana",
    onError: () => setConnectionError("Mobile wallet connection incomplete, please reopen QR Code."),
  });

  function openMobileWallet() {
    setConnectionError("");
    void connect("jupiter").catch(() => {
      setConnectionError("Mobile wallet connection incomplete, please reopen QR Code.");
    });
  }

  function disconnectMobileWallet() {
    void disconnect({ namespace: "solana" }).catch(() => {
      setConnectionError("Disconnect failed, please retry.");
    });
  }

  return <WalletConnectionContext.Provider value={{
    address: account.address,
    connected: account.isConnected && !!account.address,
    connect: openMobileWallet,
    disconnect: disconnectMobileWallet,
    isMobile: true,
    walletsCount: 1,
    connectionError,
    signTransaction: async (transaction) => {
      if (!walletProvider?.signTransaction) throw new Error("Mobile wallet does not support this transaction signing method");
      return walletProvider.signTransaction(transaction);
    },
  }}>{children}</WalletConnectionContext.Provider>;
}

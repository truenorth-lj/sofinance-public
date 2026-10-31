"use client";

import { SolanaAdapter } from "@reown/appkit-adapter-solana/react";
import { solana } from "@reown/appkit/networks";
import { createAppKit, useAppKit, useAppKitAccount, useAppKitProvider, useDisconnect } from "@reown/appkit/react";
import { useEffect, useState } from "react";
import {
  APPKIT_FEATURES,
  APPKIT_THEME_MODE,
  APPKIT_THEME_VARIABLES,
  FEATURED_SOLANA_WALLET_IDS,
  appKitSignAllTransactions,
  appKitSignAndSendTransaction,
  appKitSignMessage,
  signAppKitTransaction,
  type AppKitSolanaWalletProvider,
} from "../lib/appkit-wallet";
import { captureGrowthEvent } from "@/lib/analytics/client";
import { GROWTH_EVENTS } from "@/lib/analytics/events";
import { WalletGrowthAnalytics } from "./wallet-growth-analytics";
import { WalletConnectionContext } from "./wallet-connection";
import { TxNoticeHost } from "./transactions/tx-notice-host";
import { setTxWalletTags } from "@/lib/sentry/client-tx";

const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID?.trim();

if (typeof window !== "undefined" && projectId) {
  createAppKit({
    // Wallet Standard extensions are auto-detected via SolanaAdapter.watchStandard().
    adapters: [new SolanaAdapter()],
    networks: [solana],
    defaultNetwork: solana,
    projectId,
    metadata: {
      name: "SoFinance",
      description: "Read-only preflight specified Raydium position",
      url: window.location.origin,
      icons: [],
    },
    features: APPKIT_FEATURES,
    enableWallets: true,
    featuredWalletIds: [...FEATURED_SOLANA_WALLET_IDS],
    allWallets: "SHOW",
    themeMode: APPKIT_THEME_MODE,
    themeVariables: APPKIT_THEME_VARIABLES,
  });
}

export function MobileWalletProvider({ children }: { children: React.ReactNode }) {
  const account = useAppKitAccount({ namespace: "solana" });
  const { walletProvider } = useAppKitProvider<AppKitSolanaWalletProvider>("solana");
  const { open } = useAppKit();
  const { disconnect } = useDisconnect();
  const [connectionError, setConnectionError] = useState("");
  // Sentry: which wallet a transaction report came from, when the AppKit provider names it.
  const walletName = account.isConnected ? (walletProvider as { name?: unknown } | undefined)?.name : undefined;
  useEffect(() => {
    setTxWalletTags(typeof walletName === "string" && walletName ? { name: `appkit:${walletName}` } : null);
  }, [walletName]);

  function openWalletModal() {
    captureGrowthEvent(GROWTH_EVENTS.walletConnectClicked);
    setConnectionError("");
    void Promise.resolve(open({ view: "Connect", namespace: "solana" })).catch(() => {
      setConnectionError("Wallet connection incomplete, please try again.");
    });
  }

  function disconnectWallet() {
    void disconnect({ namespace: "solana" }).catch(() => {
      setConnectionError("Disconnect failed, please retry.");
    });
  }

  return <WalletConnectionContext.Provider value={{
    address: account.address,
    connected: account.isConnected && !!account.address,
    connect: openWalletModal,
    disconnect: disconnectWallet,
    isMobile: true,
    walletsCount: FEATURED_SOLANA_WALLET_IDS.length,
    connectionError,
    signTransaction: (transaction) => signAppKitTransaction(walletProvider, transaction),
    signAndSendTransaction: appKitSignAndSendTransaction(walletProvider),
    signAllTransactions: appKitSignAllTransactions(walletProvider),
    signMessage: appKitSignMessage(walletProvider),
  }}><WalletGrowthAnalytics />{children}<TxNoticeHost wallet={account.address} /></WalletConnectionContext.Provider>;
}

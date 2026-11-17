"use client";

import { SolanaAdapter } from "@reown/appkit-adapter-solana/react";
import { solana, type AppKitNetwork } from "@reown/appkit/networks";
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
import { WalletGrowthAnalytics } from "./wallet-growth-analytics";
import { WalletConnectionContext } from "./wallet-connection";
import { TxNoticeHost } from "./transactions/tx-notice-host";
import { setTxWalletTags } from "@/lib/sentry/client-tx";
import { AppKitConnectAnalytics } from "./appkit-connect-analytics";
import { useSolanaConnectFlow } from "./use-solana-connect-flow";
import { WalletDeeplinkSheet } from "./wallet-deeplink-sheet";

const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID?.trim();

// viem 2.57.19 added PrepareTransactionRequestPhase "afterFillTransactionError".
// AppKit's AppKitNetwork type still expects the previous phase union, so the
// official `solana` network object is not assignable without this assertion.
const solanaNetwork = solana as AppKitNetwork;

if (typeof window !== "undefined" && projectId) {
  createAppKit({
    // Wallet Standard extensions are auto-detected via SolanaAdapter.watchStandard().
    adapters: [new SolanaAdapter()],
    networks: [solanaNetwork],
    defaultNetwork: solanaNetwork,
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

  const flow = useSolanaConnectFlow(() => {
    setConnectionError("");
    void Promise.resolve(open({ view: "Connect", namespace: "solana" })).catch(() => {
      setConnectionError("Wallet connection incomplete, please try again.");
    });
  });

  function disconnectWallet() {
    void disconnect({ namespace: "solana" }).catch(() => {
      setConnectionError("Disconnect failed, please retry.");
    });
  }

  return <WalletConnectionContext.Provider value={{
    address: account.address,
    connected: account.isConnected && !!account.address,
    connect: flow.connect,
    disconnect: disconnectWallet,
    isMobile: true,
    walletsCount: FEATURED_SOLANA_WALLET_IDS.length,
    connectionError,
    signTransaction: (transaction) => signAppKitTransaction(walletProvider, transaction),
    signAndSendTransaction: appKitSignAndSendTransaction(walletProvider),
    signAllTransactions: appKitSignAllTransactions(walletProvider),
    signMessage: appKitSignMessage(walletProvider),
  }}><WalletGrowthAnalytics walletName={typeof walletName === "string" ? walletName : undefined} />
    <AppKitConnectAnalytics />
    <WalletDeeplinkSheet open={flow.sheetOpen} pageUrl={flow.pageUrl} origin={flow.origin} onOpenWallet={flow.openWallet} onChooseWalletHere={flow.chooseWalletHere} onClose={flow.closeSheet} />
    {children}<TxNoticeHost wallet={account.address} /></WalletConnectionContext.Provider>;
}

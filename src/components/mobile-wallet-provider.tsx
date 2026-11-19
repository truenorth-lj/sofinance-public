"use client";

import { SolanaAdapter } from "@reown/appkit-adapter-solana/react";
import { solana, type AppKitNetwork } from "@reown/appkit/networks";
import { createAppKit, useAppKitAccount, useAppKitProvider } from "@reown/appkit/react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { WalletConnectionContext, type WalletConnection } from "./wallet-connection";
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

const appKit = typeof window !== "undefined" && projectId
  ? createAppKit({
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
  }) : undefined;

function useReownWalletConnection(): { value: WalletConnection; walletName: string | undefined; flow: ReturnType<typeof useSolanaConnectFlow>; address: string | undefined } {
  const account = useAppKitAccount({ namespace: "solana" });
  const { walletProvider } = useAppKitProvider<AppKitSolanaWalletProvider>("solana");
  const [connectionError, setConnectionError] = useState("");
  const [initialization, setInitialization] = useState<"pending" | "ready" | "failed">(appKit ? "pending" : "ready");
  useEffect(() => {
    if (!appKit) return;
    let active = true;
    // ready() includes reconnection. AppKit's UI `initialized` flag does not guarantee it has finished.
    void appKit.ready().then(() => {
      if (active) setInitialization("ready");
    }, () => {
      if (active) {
        setInitialization("failed");
        setConnectionError("Wallet restoration failed, please reconnect.");
      }
    });
    return () => { active = false; };
  }, []);
  // Sentry: which wallet a transaction report came from, when the AppKit provider names it.
  const walletName = account.isConnected ? (walletProvider as { name?: unknown } | undefined)?.name : undefined;
  useEffect(() => {
    setTxWalletTags(typeof walletName === "string" && walletName ? { name: `appkit:${walletName}` } : null);
  }, [walletName]);

  // AppKit 1.8.24's useAppKit().open and useDisconnect().disconnect are new every render.
  // useSolanaConnectFlow would then refresh flow.connect, the context value, and onChange in a loop.
  // The module-level appKit instance is stable (it has open() and disconnect(namespace)).
  const openModal = useCallback(() => {
    setConnectionError("");
    void Promise.resolve(appKit?.open({ view: "Connect", namespace: "solana" })).catch(() => {
      setConnectionError("Wallet connection incomplete, please try again.");
    });
  }, []);

  const flow = useSolanaConnectFlow(openModal);

  const disconnectWallet = useCallback(() => {
    void Promise.resolve(appKit?.disconnect("solana")).catch(() => {
      setConnectionError("Disconnect failed, please retry.");
    });
  }, []);

  const restoring = initialization === "pending" || (initialization === "ready" && (account.status === "connecting" || account.status === "reconnecting"));
  const value = useMemo<WalletConnection>(() => ({
    address: account.address,
    connected: account.isConnected && !!account.address,
    restoring,
    connect: flow.connect,
    disconnect: disconnectWallet,
    isMobile: true,
    walletsCount: FEATURED_SOLANA_WALLET_IDS.length,
    connectionError,
    signTransaction: (transaction) => signAppKitTransaction(walletProvider, transaction),
    signAndSendTransaction: appKitSignAndSendTransaction(walletProvider),
    signAllTransactions: appKitSignAllTransactions(walletProvider),
    signMessage: appKitSignMessage(walletProvider),
  }), [account.address, account.isConnected, connectionError, disconnectWallet, flow.connect, restoring, walletProvider]);

  return { value, walletName: typeof walletName === "string" ? walletName : undefined, flow, address: account.address };
}

function AppKitWalletChrome({ walletName, flow, address }: { walletName: string | undefined; flow: ReturnType<typeof useSolanaConnectFlow>; address: string | undefined }) {
  return <>
    <WalletGrowthAnalytics walletName={walletName} />
    <AppKitConnectAnalytics />
    <WalletDeeplinkSheet open={flow.sheetOpen} pageUrl={flow.pageUrl} origin={flow.origin} onOpenWallet={flow.openWallet} onChooseWalletHere={flow.chooseWalletHere} onClose={flow.closeSheet} />
    <TxNoticeHost wallet={address} />
  </>;
}

/**
 * Client-only AppKit hook island. Must be a sibling of page children, not a wrapper: `dynamic(..., { ssr: false })`
 * would otherwise omit the document body, and swapping this in as the parent remounts TermsGate and the page.
 * Pushes the live wallet value up to the stable WalletConnectionContext.Provider.
 */
export function MobileWalletBridge({ onChange }: { onChange: (value: WalletConnection) => void }) {
  const { value, walletName, flow, address } = useReownWalletConnection();
  useEffect(() => { onChange(value); }, [onChange, value]);
  return <AppKitWalletChrome walletName={walletName} flow={flow} address={address} />;
}

/** Test/legacy tree that still wraps children. Production uses MobileWalletBridge under a stable Provider. */
export function MobileWalletProvider({ children }: { children: React.ReactNode }) {
  const { value, walletName, flow, address } = useReownWalletConnection();
  return <WalletConnectionContext.Provider value={value}>
    <AppKitWalletChrome walletName={walletName} flow={flow} address={address} />
    {children}
  </WalletConnectionContext.Provider>;
}

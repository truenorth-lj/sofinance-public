"use client";
import "@/lib/engine-host";
import { ConnectionProvider, WalletProvider, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletModalProvider, useWalletModal } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { PUBLIC_SOLANA_RPC_URL } from "@sofinance/engine/rpc/urls";
import { WalletGrowthAnalytics } from "./wallet-growth-analytics";
import { WalletConnectionContext, type WalletConnection } from "./wallet-connection";
import { AdapterConnectAnalytics } from "./adapter-connect-analytics";
import { useSolanaConnectFlow } from "./use-solana-connect-flow";
import { WalletDeeplinkSheet } from "./wallet-deeplink-sheet";
import { TermsGate } from "./terms-gate";
import { EvmWalletProvider } from "./evm-wallet-connection";
import { TxNoticeHost } from "./transactions/tx-notice-host";
import { setTxWalletTags } from "@/lib/sentry/client-tx";

const MobileWalletProvider = dynamic(() => import("./mobile-wallet-provider").then((module) => module.MobileWalletProvider), { ssr: false });

/** Disconnected stub so /app pages can SSR (nav, public tables, JSON-LD) before AppKit loads on the client. */
const SSR_DISCONNECTED_WALLET: WalletConnection = {
  connected: false,
  restoring: false,
  connect: () => {},
  disconnect: () => {},
  isMobile: false,
  walletsCount: 0,
  connectionError: "",
  signTransaction: async () => {
    throw new Error("Wallet is not connected");
  },
};

/**
 * AppKit cannot run on the server, so MobileWalletProvider is loaded with `dynamic(..., { ssr: false })`.
 * That component must not wrap `children` on the server: Next then omits the entire /app document body
 * (including the public pool table and ItemList JSON-LD). Render children during SSR; swap in AppKit after mount.
 */
const subscribeIsClient = () => () => {};

function MobileWalletBranch({ children }: { children: React.ReactNode }) {
  // getServerSnapshot is false so SSR/hydration stay disconnected; the client snapshot is true after hydrate.
  const mounted = useSyncExternalStore(subscribeIsClient, () => true, () => false);
  if (!mounted) {
    return (
      <WalletConnectionContext.Provider value={SSR_DISCONNECTED_WALLET}>
        <TermsGate>{children}</TermsGate>
      </WalletConnectionContext.Provider>
    );
  }
  return <MobileWalletProvider><TermsGate>{children}</TermsGate></MobileWalletProvider>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || PUBLIC_SOLANA_RPC_URL;
  const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID?.trim();

  // The EVM wallet (Robinhood Chain) sits beside the Solana providers, not inside them: separate state, separate buttons.
  return <EvmWalletProvider><ConnectionProvider endpoint={endpoint}>
    {projectId ? <MobileWalletBranch>{children}</MobileWalletBranch> : <BrowserWalletProvider><TermsGate>{children}</TermsGate></BrowserWalletProvider>}
  </ConnectionProvider></EvmWalletProvider>;
}

function BrowserWalletProvider({ children }: { children: React.ReactNode }) {
  // Empty list on purpose: @solana/wallet-adapter-react auto-detects Wallet Standard
  // wallets (Phantom, Solflare, Backpack, …). Passing those adapters would duplicate them.
  const wallets = useMemo(() => [], []);
  return <WalletProvider wallets={wallets} autoConnect><WalletModalProvider><BrowserWalletConnection>{children}</BrowserWalletConnection></WalletModalProvider></WalletProvider>;
}

function BrowserWalletConnection({ children }: { children: React.ReactNode }) {
  const { publicKey, connected, connecting, disconnect, wallets, wallet, signTransaction, sendTransaction, signAllTransactions, signMessage } = useWallet();
  const { connection } = useConnection();
  const address = publicKey?.toBase58();
  // Phantom and other Wallet Standard wallets broadcast themselves (and rebroadcast until expiry).
  const canSignAndSend = walletSupportsSignAndSend(wallet?.adapter);
  const { setVisible } = useWalletModal();
  const flow = useSolanaConnectFlow(() => setVisible(true));
  // Sentry: which wallet a transaction report came from (name, and the Wallet Standard version when exposed).
  const walletName = connected ? wallet?.adapter.name : undefined;
  const walletVersion = connected ? (wallet?.adapter as { wallet?: { version?: unknown } } | undefined)?.wallet?.version : undefined;
  useEffect(() => {
    setTxWalletTags(walletName ? { name: walletName, version: typeof walletVersion === "string" ? walletVersion : undefined } : null);
  }, [walletName, walletVersion]);
  return <WalletConnectionContext.Provider value={{
    address, connected, restoring: connecting, connect: flow.connect,
    disconnect: () => { void disconnect(); }, isMobile: false, walletsCount: wallets.length, connectionError: "",
    signTransaction: async (transaction) => {
      if (!signTransaction) throw new Error("This wallet does not support transaction signing");
      return signTransaction(transaction);
    },
    signAndSendTransaction: canSignAndSend
      ? (transaction) => sendTransaction(transaction, connection, { preflightCommitment: "confirmed" })
      : undefined,
    signAllTransactions: signAllTransactions ? (transactions) => signAllTransactions(transactions) : undefined,
    signMessage: signMessage ? async (message) => {
      const signature = await signMessage(message);
      return signature;
    } : undefined,
  }}><WalletGrowthAnalytics walletName={walletName} /><AdapterConnectAnalytics />
    <WalletDeeplinkSheet open={flow.sheetOpen} pageUrl={flow.pageUrl} origin={flow.origin} onOpenWallet={flow.openWallet} onChooseWalletHere={flow.chooseWalletHere} onClose={flow.closeSheet} />
    {children}<TxNoticeHost wallet={address} /></WalletConnectionContext.Provider>;
}

/** True only for Wallet Standard wallets that expose `solana:signAndSendTransaction`. */
export function walletSupportsSignAndSend(adapter: unknown): boolean {
  const standard = adapter as { wallet?: { features?: Record<string, unknown> } } | undefined;
  return !!standard?.wallet?.features?.["solana:signAndSendTransaction"];
}

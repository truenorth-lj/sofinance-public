"use client";
import "@/lib/engine-host";
import { ConnectionProvider, WalletProvider, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletModalProvider, useWalletModal } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { PUBLIC_SOLANA_RPC_URL } from "@sofinance/engine/rpc/urls";
import { WalletGrowthAnalytics } from "./wallet-growth-analytics";
import { DISCONNECTED_RESTORING_WALLET, WalletConnectionContext } from "./wallet-connection";
import { AdapterConnectAnalytics } from "./adapter-connect-analytics";
import { useSolanaConnectFlow } from "./use-solana-connect-flow";
import { WalletDeeplinkSheet } from "./wallet-deeplink-sheet";
import { TermsGate } from "./terms-gate";
import { EvmWalletProvider } from "./evm-wallet-connection";
import { TxNoticeHost } from "./transactions/tx-notice-host";
import { setTxWalletTags } from "@/lib/sentry/client-tx";

const MobileWalletBridge = dynamic(() => import("./mobile-wallet-provider").then((module) => module.MobileWalletBridge), { ssr: false });

/**
 * AppKit cannot run on the server, so the hook island is loaded with `dynamic(..., { ssr: false })`.
 * That island must not wrap `children`: Next would omit the /app document body (H1, table, ItemList), and
 * swapping it in as the parent remounts TermsGate and the page (blank frame, effects re-run).
 * Keep a stable Provider + TermsGate root; after mount, load the bridge as a sibling and push its value up.
 */
const subscribeIsClient = () => () => {};

function MobileWalletBranch({ children }: { children: React.ReactNode }) {
  const [value, setValue] = useState(DISCONNECTED_RESTORING_WALLET);
  // getServerSnapshot is false so SSR/hydration do not render the ssr:false chunk; the client snapshot is true after hydrate.
  const mounted = useSyncExternalStore(subscribeIsClient, () => true, () => false);
  return (
    <WalletConnectionContext.Provider value={value}>
      <TermsGate>{children}</TermsGate>
      {mounted ? <MobileWalletBridge onChange={setValue} /> : null}
    </WalletConnectionContext.Provider>
  );
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

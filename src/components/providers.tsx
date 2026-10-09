"use client";
import { ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import { WalletModalProvider, useWalletModal } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import dynamic from "next/dynamic";
import { useMemo } from "react";
import { WalletConnectionContext } from "./wallet-connection";

const MobileWalletProvider = dynamic(() => import("./mobile-wallet-provider").then((module) => module.MobileWalletProvider), { ssr: false });

export function Providers({ children }: { children: React.ReactNode }) {
  const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID?.trim();

  return <ConnectionProvider endpoint={endpoint}>
    {projectId ? <MobileWalletProvider>{children}</MobileWalletProvider> : <BrowserWalletProvider>{children}</BrowserWalletProvider>}
  </ConnectionProvider>;
}

function BrowserWalletProvider({ children }: { children: React.ReactNode }) {
  // Empty list on purpose: @solana/wallet-adapter-react auto-detects Wallet Standard
  // wallets (Phantom, Solflare, Backpack, …). Passing those adapters would duplicate them.
  const wallets = useMemo(() => [], []);
  return <WalletProvider wallets={wallets} autoConnect><WalletModalProvider><BrowserWalletConnection>{children}</BrowserWalletConnection></WalletModalProvider></WalletProvider>;
}

function BrowserWalletConnection({ children }: { children: React.ReactNode }) {
  const { publicKey, connected, disconnect, wallets, signTransaction, signMessage } = useWallet();
  const { setVisible } = useWalletModal();
  return <WalletConnectionContext.Provider value={{
    address: publicKey?.toBase58(), connected, connect: () => setVisible(true),
    disconnect: () => { void disconnect(); }, isMobile: false, walletsCount: wallets.length, connectionError: "",
    signTransaction: async (transaction) => {
      if (!signTransaction) throw new Error("This wallet does not support transaction signing");
      return signTransaction(transaction);
    },
    signMessage: signMessage ? async (message) => {
      const signature = await signMessage(message);
      return signature;
    } : undefined,
  }}>{children}</WalletConnectionContext.Provider>;
}

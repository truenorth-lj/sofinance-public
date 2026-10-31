import type { VersionedTransaction } from "@solana/web3.js";

/**
 * WalletConnect explorer IDs (Reown WalletGuide / AppKit WalletButtonsIds).
 * Featured on the Connect modal; All Wallets still lists every Solana wallet.
 */
export const FEATURED_SOLANA_WALLET_IDS = [
  "a797aa35c0fadbfc1a53e7f675162ed5226968b44a19ee3d24385c64d1d3c393", // Phantom
  "1ca0bdd4747578705b1939af023d120677c64fe6ca76add81fda36e350605e79", // Solflare
  "2bd8c14e035c2d48f184aaa168559e86b0e3433228d3c4075900a221785019b0", // Backpack
  "0ef262ca2a56b88d179c93a21383fee4e135bd7bc6680e5c2356ff8e38301037", // Jupiter
  "4622a2b2d6af1c9844944291e5e7351a6aa24cd7b23099efac1b2fd875da31a0", // Trust
  "971e689d0a5be527bac79629b4ee9b925e82208e5168b733496a09c0faed0709", // OKX
] as const;

export const APPKIT_FEATURES = { analytics: false, email: false, socials: [] };

export const APPKIT_THEME_MODE = "dark" as const;

/** Ink black/white as far as AppKit theming allows (--apkt and legacy --w3m). */
export const APPKIT_THEME_VARIABLES = {
  "--apkt-accent": "#f5f5f5",
  "--apkt-color-mix": "#050505",
  "--apkt-color-mix-strength": 40,
  "--apkt-border-radius-master": "3px",
  "--w3m-accent": "#f5f5f5",
  "--w3m-color-mix": "#050505",
  "--w3m-color-mix-strength": 40,
  "--w3m-border-radius-master": "3px",
} as const;

/**
 * AppKit `useAppKitProvider("solana")` surface for both Wallet Standard
 * extensions and WalletConnect (`SolanaWalletConnectProvider`).
 */
export type AppKitSolanaWalletProvider = {
  signTransaction?: (transaction: VersionedTransaction) => Promise<VersionedTransaction>;
  signAllTransactions?: (transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>;
  signAndSendTransaction?: (transaction: VersionedTransaction, options?: { preflightCommitment?: "confirmed"; maxRetries?: number }) => Promise<string>;
  session?: { namespaces?: { solana?: { methods?: string[] } } };
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
};

export async function signAppKitTransaction(
  walletProvider: AppKitSolanaWalletProvider | undefined,
  transaction: VersionedTransaction,
): Promise<VersionedTransaction> {
  if (!walletProvider?.signTransaction) {
    throw new Error("Connected wallet does not support this transaction signing method");
  }
  return walletProvider.signTransaction(transaction);
}

export function appKitSignMessage(
  walletProvider: AppKitSolanaWalletProvider | undefined,
): ((message: Uint8Array) => Promise<Uint8Array>) | undefined {
  if (!walletProvider?.signMessage) return undefined;
  return async (message) => {
    if (!walletProvider.signMessage) throw new Error("Connected wallet does not support message signing");
    return walletProvider.signMessage(message);
  };
}

/** Expose only one-request signing, including WalletConnect's negotiated capability. */
export function appKitSignAllTransactions(
  walletProvider: AppKitSolanaWalletProvider | undefined,
): ((transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>) | undefined {
  function supportsBatch(): boolean {
    if (!walletProvider?.signAllTransactions) return false;
    // AppKit silently loops signTransaction for unsupported WalletConnect sessions.
    // Check before calling it so this action always remains one approval request.
    return !("session" in walletProvider)
      || walletProvider.session?.namespaces?.solana?.methods?.includes("solana_signAllTransactions") === true;
  }
  if (!supportsBatch()) return undefined;
  return async (transactions) => {
    if (!supportsBatch() || !walletProvider?.signAllTransactions) {
      throw new Error("Connected wallet does not support one-request batch signing");
    }
    return walletProvider.signAllTransactions(transactions);
  };
}

/** Wallet-side broadcast when the extension or WalletConnect session supports it. */
export function appKitSignAndSendTransaction(
  walletProvider: AppKitSolanaWalletProvider | undefined,
): ((transaction: VersionedTransaction) => Promise<string>) | undefined {
  const send = walletProvider?.signAndSendTransaction;
  if (!send) return undefined;
  const methods = walletProvider.session?.namespaces?.solana?.methods;
  if (walletProvider.session && !methods?.includes("solana_signAndSendTransaction")) return undefined;
  return (transaction) => send.call(walletProvider, transaction, { preflightCommitment: "confirmed" });
}

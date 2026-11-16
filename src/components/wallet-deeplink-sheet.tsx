"use client";

import { X } from "lucide-react";
import { phantomBrowseUrl, solflareBrowseUrl } from "@/lib/analytics/wallet-connect";

/**
 * Mobile-only: when no injected Solana wallet is present, offer official Phantom and Solflare
 * browse deeplinks so this page opens in the wallet's in-app browser.
 */
export function WalletDeeplinkSheet({ open, pageUrl, origin, onOpenWallet, onClose }: {
  open: boolean;
  pageUrl: string;
  origin: string;
  onOpenWallet: (wallet: "Phantom" | "Solflare") => void;
  onClose: () => void;
}) {
  if (!open) return null;
  const wallets = [
    { name: "Phantom" as const, href: phantomBrowseUrl(pageUrl, origin) },
    { name: "Solflare" as const, href: solflareBrowseUrl(pageUrl, origin) },
  ];
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4" data-testid="wallet-deeplink-backdrop" onClick={onClose}>
    <div role="dialog" aria-modal="true" aria-labelledby="wallet-deeplink-title" data-testid="wallet-deeplink-sheet"
      className="w-full max-w-md rounded-t-[28px] border border-white/12 bg-char p-6 text-cream sm:rounded-[28px] sm:p-7"
      onClick={(event) => event.stopPropagation()}>
      <div className="flex items-start justify-between gap-4">
        <h2 id="wallet-deeplink-title" className="text-lg font-semibold">Open in your wallet</h2>
        <button type="button" aria-label="Close" onClick={onClose}
          className="rounded-full border border-white/25 p-1.5 text-cream/85 hover:border-white/70 focus-visible:border-lemon">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <p className="mt-2 text-sm leading-6 text-smoke">No wallet was found in this browser. Open this page in Phantom or Solflare to connect.</p>
      <div className="mt-5 grid gap-2">
        {wallets.map((wallet) => (
          <a key={wallet.name} href={wallet.href} data-testid={`wallet-deeplink-${wallet.name.toLowerCase()}`}
            onClick={() => onOpenWallet(wallet.name)}
            className="inline-flex h-12 items-center justify-center rounded-full bg-lemon px-5 text-sm font-semibold text-ink transition-colors hover:bg-[#fff27f] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lemon">
            Open in {wallet.name}
          </a>
        ))}
      </div>
    </div>
  </div>;
}

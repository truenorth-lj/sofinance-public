"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";
import { LoaderCircle, Wallet } from "lucide-react";
import { cn } from "@/lib/cn";
import { homepageWallet, REMEMBERED_WALLET_KEY, useHomepageWallet } from "./homepage-wallet";

const HomepageWalletRoot = dynamic(() => import("./homepage-wallet-root").then((module) => module.HomepageWalletRoot), { ssr: false });

/**
 * Mounts the homepage's wallet root once it is needed: on the first Connect wallet or Buy, or right after load when the
 * browser remembers a wallet (so the header shows it, as `/app` would). Rendered once per page, outside the Suspense
 * boundary, so there is never a second providers tree.
 */
export function HomepageWalletIsland() {
  const { mounted } = useHomepageWallet();
  useEffect(() => {
    let remembered = false;
    try { remembered = Boolean(window.localStorage.getItem(REMEMBERED_WALLET_KEY)); } catch { /* storage blocked: wait for a click */ }
    if (remembered) homepageWallet.mount();
  }, []);
  return mounted ? <HomepageWalletRoot /> : null;
}

const pill = "flex h-10 min-w-0 items-center justify-center gap-2 rounded-full px-5 text-[13px] font-semibold outline-none transition-colors";
const short = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;

/**
 * The homepage header's wallet button. Connect wallet opens the wallet picker in place (the page stays); once connected
 * it shows the wallet like the app bar does, and a click disconnects it, as there.
 */
export function HomepageConnectButton() {
  const { mounted, ready, address } = useHomepageWallet();
  if (address) {
    return <button type="button" onClick={homepageWallet.disconnect} data-testid="home-wallet" data-connected="true"
      title="Disconnect Solana wallet" aria-label={`Solana wallet ${short(address)}, connected. Disconnect`}
      className={cn(pill, "border border-white/40 px-4 font-medium text-cream hover:border-white/70 focus-visible:border-lemon")}>
      <Wallet className="hidden h-4 w-4 shrink-0 sm:block" aria-hidden="true" />
      <span className="truncate font-data text-[12px]">{short(address)}</span>
      <span className="shrink-0 rounded-full bg-white/12 px-1.5 py-px text-[10px] font-semibold leading-4 tracking-wide text-cream/80">SOL</span>
    </button>;
  }
  const loading = mounted && !ready;
  return <button type="button" onClick={homepageWallet.requestConnect} data-testid="home-wallet" data-connected="false" aria-busy={loading || undefined}
    title="Connect a Solana wallet (Phantom, Solflare, …)"
    className={cn(pill, "bg-cream text-ink hover:bg-white focus-visible:shadow-[0_0_0_2px_var(--color-lemon)]")}>
    {loading ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
    Connect wallet
  </button>;
}

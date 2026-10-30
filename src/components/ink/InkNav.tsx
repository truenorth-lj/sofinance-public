"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandMark } from "@/components/brand-mark";
import { Wallet } from "lucide-react";
import { cn } from "@/lib/cn";
import { APP_ROUTES, BLOG_ROUTES, DOCS_ROUTES } from "@/lib/public-urls";
import { EXTERNAL_LINK_PROPS, SOCIAL_LINKS } from "@/lib/social-links";
import { XIcon } from "@/components/x-icon";
import { useOptionalEvmWalletConnection } from "@/components/evm-wallet-connection";
import { RHC_CHAIN_ID } from "@/lib/rhc-wallet/eip1193";

interface InkNavProps {
  wallet?: string | null;
  connected?: boolean;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

const short = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;
const shortEvm = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;

const NAV_LINKS = [
  { href: APP_ROUTES.home, label: "Positions" },
  { href: APP_ROUTES.plan, label: "Plan" },
  { href: APP_ROUTES.rwaPairs, label: "RWA pairs" },
  { href: APP_ROUTES.ai, label: "Use AI" },
  { href: DOCS_ROUTES.home, label: "Docs" },
  { href: BLOG_ROUTES.home, label: "Blog" },
] as const;

const pill =
  "flex h-10 items-center justify-center rounded-full border px-4 text-[13px] font-medium outline-none transition-colors";

export function InkNav({ wallet, connected, onConnect, onDisconnect }: InkNavProps) {
  const pathname = usePathname();
  const evm = useOptionalEvmWalletConnection();
  // Wallet buttons only on app pages (they pass the Solana handlers); docs, blog and terms show none.
  const showSolana = Boolean(onConnect && onDisconnect);
  const showEvm = showSolana && Boolean(evm?.enabled);
  const solanaConnected = Boolean(connected && wallet);
  const evmBusy = evm?.status === "connecting" || evm?.status === "restoring";
  const evmOnRhc = evm?.chainId === RHC_CHAIN_ID;

  return (
    // Below sm: brand + X on the first row, the two wallet buttons on the second, links below. sm–lg: brand, X and
    // wallets share the first row. lg: one row.
    <header className="flex flex-wrap items-center justify-between gap-2">
      <Link
        href={APP_ROUTES.home}
        className="order-1 flex h-10 items-center gap-2 rounded-full bg-lemon pl-1.5 pr-4 text-[13px] font-semibold text-ink outline-none focus-visible:shadow-[0_0_0_2px_var(--color-cream)]"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ink">
          <BrandMark className="h-5 w-5 text-lemon" />
        </span>
        SoFinance
      </Link>

      <nav aria-label="App" className="order-5 flex w-full flex-wrap gap-2 lg:order-2 lg:w-auto lg:flex-1">
        {NAV_LINKS.map((link) => {
          const isPrefixNav =
            link.href === DOCS_ROUTES.home || link.href === BLOG_ROUTES.home;
          const isActive = isPrefixNav
            ? pathname === link.href || pathname.startsWith(`${link.href}/`)
            : pathname === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                pill,
                "min-w-fit flex-1",
                isActive
                  ? "border-cream bg-cream text-ink"
                  : "border-white/25 text-cream/85 hover:border-white/70 focus-visible:border-lemon",
              )}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>

      <a
        href={SOCIAL_LINKS.x.href}
        {...EXTERNAL_LINK_PROPS}
        aria-label={SOCIAL_LINKS.x.ariaLabel}
        title={SOCIAL_LINKS.x.ariaLabel}
        className={cn(
          pill,
          "order-2 w-10 shrink-0 border-white/25 px-0 text-cream/85 hover:border-white/70 focus-visible:border-lemon sm:ml-auto lg:order-3 lg:ml-0",
        )}
      >
        <XIcon className="h-3.5 w-3.5" />
      </a>

      {showSolana && (
        <div className="order-3 grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto lg:order-4" data-testid="nav-wallets">
          <button
            type="button"
            onClick={solanaConnected ? onDisconnect : onConnect}
            title={solanaConnected ? "Disconnect Solana wallet" : "Connect a Solana wallet (Phantom, Solflare, …)"}
            aria-label={solanaConnected && wallet ? `Solana wallet ${short(wallet)}, connected. Disconnect` : undefined}
            data-testid="nav-solana-wallet"
            data-connected={solanaConnected ? "true" : "false"}
            className={cn(walletPill, solanaConnected ? walletOn : walletOff)}
          >
            <Wallet className={cn("h-4 w-4 shrink-0", solanaConnected && "hidden sm:block")} aria-hidden="true" />
            {solanaConnected && wallet ? <WalletLabel address={short(wallet)} chain="SOL" /> : <span className="truncate">Solana wallet</span>}
          </button>
          {showEvm && evm && (evm.wallet && !evmOnRhc ? (
            // Wrong network: the address still disconnects; the amber button switches (or adds) Robinhood Chain.
            <div className={cn(walletGroup, walletOn)} data-testid="nav-evm-group">
              <button
                type="button"
                onClick={evm.disconnect}
                title="Disconnect EVM wallet (not on Robinhood Chain)"
                aria-label={`EVM wallet ${shortEvm(evm.wallet.address)} on another network, connected. Disconnect`}
                data-testid="nav-evm-wallet"
                data-connected="true"
                className="flex h-full min-w-0 items-center gap-2 rounded-l-full pl-3 pr-1 outline-none focus-visible:text-lemon sm:pl-4"
              >
                <Wallet className="hidden h-4 w-4 shrink-0 sm:block" aria-hidden="true" />
                <span className="truncate font-data text-[12px]">{shortEvm(evm.wallet.address)}</span>
              </button>
              <button
                type="button"
                onClick={() => { void evm.switchNetwork().catch(() => {}); }}
                title="Switch the EVM wallet to Robinhood Chain"
                data-testid="nav-evm-switch"
                className="mr-1 shrink-0 rounded-full bg-amber-300/20 px-2 py-1 text-[11px] font-semibold leading-4 text-amber-200 outline-none hover:bg-amber-300/30 focus-visible:shadow-[0_0_0_2px_var(--color-lemon)]"
              >
                Wrong network
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={evm.wallet ? evm.disconnect : () => { evm.dismissError(); void evm.connect().catch(() => {}); }}
              disabled={evmBusy}
              title={evm.wallet ? "Disconnect EVM wallet (Robinhood Chain)" : "Connect an EVM wallet (MetaMask) for Robinhood Chain"}
              aria-label={evm.wallet ? `EVM wallet ${shortEvm(evm.wallet.address)} on Robinhood Chain, connected. Disconnect` : undefined}
              data-testid="nav-evm-wallet"
              data-connected={evm.wallet ? "true" : "false"}
              className={cn(walletPill, evm.wallet ? walletOn : walletOff, "disabled:cursor-wait disabled:opacity-60")}
            >
              <Wallet className={cn("h-4 w-4 shrink-0", evm.wallet && "hidden sm:block")} aria-hidden="true" />
              {evm.wallet
                ? <WalletLabel address={shortEvm(evm.wallet.address)} chain="RHC" />
                : <span className="truncate">{evm.status === "connecting" ? "Connecting…" : "EVM wallet"}</span>}
            </button>
          ))}
        </div>
      )}

      {showEvm && evm?.error && (
        <p role="alert" className="order-4 flex w-full items-center justify-end gap-2 text-xs text-red-200 lg:order-6" data-testid="nav-evm-error">
          <span>EVM wallet: {evm.error}</span>
          <button type="button" onClick={evm.dismissError} className="underline underline-offset-2">Dismiss</button>
        </p>
      )}
    </header>
  );
}

const walletPill = "flex h-10 min-w-0 items-center justify-center gap-1.5 rounded-full border px-3 text-[13px] sm:gap-2 sm:px-4 font-medium outline-none transition-colors focus-visible:border-lemon";
const walletGroup = "flex h-10 min-w-0 items-center justify-between rounded-full border text-[13px] font-medium transition-colors";
const walletOff = "border-white/25 text-cream/85 hover:border-white/70";
const walletOn = "border-white/40 text-cream hover:border-white/70";

// Below sm the two pills share one row (about 165px each at 375px), so a connected pill drops the wallet icon to keep the
// whole short address visible.
function WalletLabel({ address, chain }: { address: string; chain: string }) {
  return <>
    <span className="truncate font-data text-[12px]">{address}</span>
    <span className="shrink-0 rounded-full bg-white/12 px-1.5 py-px text-[10px] font-semibold leading-4 tracking-wide text-cream/80">{chain}</span>
  </>;
}

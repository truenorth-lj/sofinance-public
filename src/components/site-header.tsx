"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X as CloseIcon } from "lucide-react";
import { HomepageWalletIsland } from "@/components/homepage-wallet-island";
import { homepageWallet, useHomepageWallet } from "@/components/homepage-wallet";
import { InkNav, type InkNavProps } from "@/components/ink/InkNav";
import { SiteLogo } from "@/components/site-logo";
import { cn } from "@/lib/cn";
import { navGroup } from "@/lib/nav-group";
import { isRhcUniv4TradingEnabled } from "@/lib/protocol-flags";
import { APP_ROUTES, BLOG_ROUTES, GUIDE_ROUTES } from "@/lib/public-urls";

const pill =
  "flex h-10 items-center justify-center rounded-full border px-4 text-[13px] font-medium outline-none transition-colors";

const APP_NAV_ITEMS = [
  { href: APP_ROUTES.rwaPairs, label: "Pools" },
  { href: APP_ROUTES.home, label: "Portfolio" },
  { href: APP_ROUTES.ai, label: "AI agents" },
] as const;

const MARKETING_NAV_ITEMS = [
  { href: APP_ROUTES.rwaPairs, label: "Pools" },
  { href: GUIDE_ROUTES.learn, label: "Learn" },
  { href: APP_ROUTES.ai, label: "AI agents" },
  { href: BLOG_ROUTES.home, label: "Blog" },
] as const;

/**
 * One site header. The group (marketing vs app) comes only from `navGroup(pathname)` —
 * no per-route branching and no variant prop. Both groups use the same InkNav wallet
 * slot (Solana + EVM). Pages already inside `Providers` (`/app/*`, the `/pools` list)
 * use that context; marketing pages and `/pools/[slug]` load the wallet providers
 * through a lazy client island so SSR/SEO and anonymous browsing stay unchanged.
 */
export function SiteHeader(props: InkNavProps = {}) {
  const pathname = usePathname();
  const group = navGroup(pathname);
  const island = useHomepageWallet();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const items = group === "app" ? APP_NAV_ITEMS : MARKETING_NAV_ITEMS;
  // App pages already inside Providers pass Solana handlers; InkNav then reads EVM from context.
  // Marketing pages and /pools/[slug] omit handlers, so the lazy island feeds both chains via the store.
  const fromApp = Boolean(props.onConnect && props.onDisconnect);

  const solana = fromApp
    ? {
        wallet: props.wallet,
        connected: props.connected,
        restoring: props.restoring,
        onConnect: props.onConnect,
        onDisconnect: props.onDisconnect,
      }
    : {
        wallet: island.address,
        connected: Boolean(island.address),
        restoring: island.mounted && !island.ready,
        onConnect: homepageWallet.requestConnect,
        onDisconnect: homepageWallet.disconnect,
      };

  const evm = fromApp
    ? undefined
    : {
        evmEnabled: isRhcUniv4TradingEnabled(),
        evmWallet: island.evmAddress,
        evmBusy: island.mounted && !island.evmReady,
        evmChainId: island.evmChainId,
        evmError: island.evmError,
        onEvmConnect: homepageWallet.requestEvmConnect,
        onEvmDisconnect: homepageWallet.disconnectEvm,
        onEvmDismissError: homepageWallet.dismissEvmError,
      };

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[100] focus:rounded-full focus:bg-cream focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-ink"
      >
        Skip to content
      </a>
      <header data-testid="site-header" className="flex flex-wrap items-center gap-2">
        {/* Mobile row is DOM order: logo, then wallet + Menu (Menu last) with ml-auto on the right.
            Order classes are sm: only: below sm the wrapper is a real flex container, and an un-prefixed
            order-1 on the logo would sort it after the wallet group (default order 0). sm+ uses contents
            so logo / nav / wallet join the header flex as sm:order-1 / sm:order-2 / sm:order-3. */}
        <div className="flex w-full items-center gap-1.5 sm:contents sm:gap-2">
          <SiteLogo className="sm:order-1" />
          <div className="ml-auto flex items-center gap-1.5 sm:order-3 sm:ml-0 sm:gap-2">
            <InkNav
              wallet={solana.wallet}
              connected={solana.connected}
              restoring={solana.restoring}
              onConnect={solana.onConnect}
              onDisconnect={solana.onDisconnect}
              {...evm}
            />
            <button
              type="button"
              aria-expanded={menuOpen}
              aria-controls={menuId}
              onClick={() => setMenuOpen((open) => !open)}
              aria-label="Menu"
              data-testid="nav-menu"
              className={cn(
                pill,
                "shrink-0 gap-1.5 px-2.5 sm:hidden",
                menuOpen ? "border-cream bg-cream text-ink" : "border-white/25 text-cream/85 focus-visible:border-lemon",
              )}
            >
              {menuOpen ? <CloseIcon className="h-4 w-4" aria-hidden="true" /> : <Menu className="h-4 w-4" aria-hidden="true" />}
              {/* The word is 375+ only: at 360 the row is already flush, and CI fonts overflow the page. */}
              <span className="max-[374px]:hidden">Menu</span>
            </button>
          </div>
        </div>

        <nav
          aria-label={group === "app" ? "App" : "Sections"}
          id={menuId}
          onKeyDown={(event) => { if (event.key === "Escape") setMenuOpen(false); }}
          className={cn(
            "w-full gap-2 sm:order-2 sm:flex sm:w-auto sm:flex-1 sm:flex-wrap",
            menuOpen ? "grid grid-cols-2" : "hidden",
          )}
        >
          {items.map((link) => {
            const isActive = pathname === link.href || Boolean(pathname?.startsWith(`${link.href}/`));
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={isActive ? "page" : undefined}
                onClick={() => setMenuOpen(false)}
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
      </header>
      {/* Lazy island only when this header is not already inside the app Providers tree.
          The island is a sibling of the page body, never a wrapper, so SSR/SEO stays intact. */}
      {fromApp ? null : <HomepageWalletIsland />}
    </>
  );
}

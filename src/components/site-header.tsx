"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X as CloseIcon } from "lucide-react";
import { HomepageConnectButton, HomepageWalletIsland } from "@/components/homepage-wallet-island";
import { InkNav, type InkNavProps } from "@/components/ink/InkNav";
import { SiteLogo } from "@/components/site-logo";
import { cn } from "@/lib/cn";
import { APP_ROUTES, BLOG_ROUTES, GUIDE_ROUTES } from "@/lib/public-urls";

const pill =
  "flex h-10 items-center justify-center rounded-full border px-4 text-[13px] font-medium outline-none transition-colors";

const NAV_ITEMS = [
  { href: APP_ROUTES.rwaPairs, label: "Pools" },
  { href: APP_ROUTES.home, label: "Portfolio" },
  { href: GUIDE_ROUTES.learn, label: "Learn" },
  { href: APP_ROUTES.ai, label: "AI agents" },
] as const;

/**
 * One site header. `variant` only changes the wallet slot and whether Blog is shown (11/4: Blog stays on
 * the marketing site). Pools always goes to the list page; the logo always goes home. On small screens the
 * links fold into Menu so AI agents is not dropped below 640px.
 */
export function SiteHeader({
  variant = "marketing",
  wallet,
  connected,
  restoring,
  onConnect,
  onDisconnect,
}: { variant?: "marketing" | "app" } & InkNavProps) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const items = variant === "marketing"
    ? [...NAV_ITEMS, { href: BLOG_ROUTES.home, label: "Blog" }]
    : NAV_ITEMS;

  return (
    <>
      <header data-testid="site-header" className="flex flex-wrap items-center gap-2">
        {/* Mobile row is DOM order: logo, then wallet + Menu (Menu last) with ml-auto on the right.
            Order classes are sm: only: below sm the wrapper is a real flex container, and an un-prefixed
            order-1 on the logo would sort it after the wallet group (default order 0). sm+ uses contents
            so logo / nav / wallet join the header flex as sm:order-1 / sm:order-2 / sm:order-3. */}
        <div className="flex w-full items-center gap-1.5 sm:contents sm:gap-2">
          <SiteLogo className="sm:order-1" />
          <div className="ml-auto flex items-center gap-1.5 sm:order-3 sm:ml-0 sm:gap-2">
            {variant === "marketing" ? (
              <HomepageConnectButton />
            ) : (
              <InkNav wallet={wallet} connected={connected} restoring={restoring} onConnect={onConnect} onDisconnect={onDisconnect} />
            )}
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
          aria-label={variant === "app" ? "App" : "Sections"}
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
      {/* One providers tree, outside any page Suspense boundary. App pages keep their own wallet providers. */}
      {variant === "marketing" ? <HomepageWalletIsland /> : null}
    </>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandMark } from "@/components/brand-mark";
import { Wallet } from "lucide-react";
import { cn } from "@/lib/cn";
import { APP_ROUTES, DOCS_ROUTES } from "@/lib/public-urls";
import { EXTERNAL_LINK_PROPS, SOCIAL_LINKS } from "@/lib/social-links";
import { XIcon } from "@/components/x-icon";

interface InkNavProps {
  wallet?: string | null;
  connected?: boolean;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

const short = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;

const NAV_LINKS = [
  { href: APP_ROUTES.home, label: "Positions" },
  { href: APP_ROUTES.plan, label: "Plan" },
  { href: APP_ROUTES.rwaPairs, label: "RWA pairs" },
  { href: APP_ROUTES.ai, label: "Use AI" },
  { href: DOCS_ROUTES.home, label: "Docs" },
] as const;

const pill =
  "flex h-10 items-center justify-center rounded-full border px-4 text-[13px] font-medium outline-none transition-colors";

export function InkNav({ wallet, connected, onConnect, onDisconnect }: InkNavProps) {
  const pathname = usePathname();

  return (
    // Below lg the brand and wallet share the first row and the links take the next one.
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

      <nav aria-label="App" className="order-3 flex w-full flex-wrap gap-2 lg:order-2 lg:w-auto lg:flex-1">
        {NAV_LINKS.map((link) => {
          const isActive =
            link.href === DOCS_ROUTES.home
              ? pathname === DOCS_ROUTES.home || pathname.startsWith(`${DOCS_ROUTES.home}/`)
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

      <div className="order-2 flex items-center gap-2 lg:order-3">
        <a
          href={SOCIAL_LINKS.x.href}
          {...EXTERNAL_LINK_PROPS}
          aria-label={SOCIAL_LINKS.x.ariaLabel}
          title={SOCIAL_LINKS.x.ariaLabel}
          className={cn(
            pill,
            "w-10 border-white/25 px-0 text-cream/85 hover:border-white/70 focus-visible:border-lemon",
          )}
        >
          <XIcon className="h-3.5 w-3.5" />
        </a>

        {onConnect && onDisconnect && (
          <button
            type="button"
            onClick={connected && wallet ? onDisconnect : onConnect}
            className={cn(
              pill,
              "gap-2 border-white/25 text-cream/85 hover:border-white/70 focus-visible:border-lemon",
            )}
          >
            <Wallet className="h-4 w-4" aria-hidden="true" />
            {connected && wallet ? short(wallet) : "Connect wallet"}
          </button>
        )}
      </div>
    </header>
  );
}

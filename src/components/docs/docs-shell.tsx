"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { InkNav, InkShell } from "@/components/ink";
import { DOCS_PAGES } from "@/lib/docs-nav";
import { DOCS_ROUTES, FAQ_ROUTE, LEGAL_ROUTES } from "@/lib/public-urls";
import { cn } from "@/lib/cn";

function isActive(pathname: string, href: string) {
  if (href === DOCS_ROUTES.gettingStarted) {
    return pathname === DOCS_ROUTES.gettingStarted || pathname === `${DOCS_ROUTES.gettingStarted}/`;
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function DocsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() || DOCS_ROUTES.gettingStarted;

  return (
    <InkShell>
      <InkNav />
      <div className="mt-3 grid gap-3 lg:grid-cols-12">
        <nav
          aria-label="Documentation"
          className="rounded-[28px] border border-white/12 bg-char p-4 sm:p-5 lg:col-span-3"
        >
          <p className="px-2 font-data text-[10px] uppercase tracking-[0.14em] text-smoke">Docs</p>
          <ul className="mt-3 space-y-1">
            {DOCS_PAGES.map((page) => {
              const active = isActive(pathname, page.href);
              return (
                <li key={page.href}>
                  <Link
                    href={page.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "block rounded-2xl px-3 py-2.5 text-sm outline-none transition-colors",
                      active
                        ? "bg-cream text-ink"
                        : "text-cream/85 hover:bg-white/[0.06] hover:text-cream focus-visible:bg-white/[0.06]",
                    )}
                  >
                    {page.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="min-w-0 lg:col-span-9">{children}</div>
      </div>
      <footer className="mt-6 flex flex-wrap items-center gap-5 px-2 py-4 font-data text-[11px] uppercase tracking-[0.12em] text-smoke">
        <Link href="/" className="transition-colors hover:text-cream">Home</Link>
        <Link href={FAQ_ROUTE} className="transition-colors hover:text-cream">FAQ</Link>
        <Link href={LEGAL_ROUTES.terms} className="transition-colors hover:text-cream">Terms of Service</Link>
      </footer>
    </InkShell>
  );
}

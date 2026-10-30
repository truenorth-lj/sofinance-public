import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { InkNav, InkShell } from "@/components/ink";
import { APP_ROUTES, BLOG_ROUTES, DOCS_ROUTES } from "@/lib/public-urls";
import { EXTERNAL_LINK_PROPS, SOCIAL_LINKS } from "@/lib/social-links";
import { XIcon } from "@/components/x-icon";

export function BlogAppCta() {
  return (
    <aside className="mt-3 rounded-[28px] bg-cream p-6 text-ink sm:p-8">
      <h2 className="max-w-[16ch] text-[clamp(1.6rem,3vw,2.2rem)] font-medium leading-[1.08] tracking-[-0.03em]">
        Open the app
      </h2>
      <p className="mt-4 max-w-xl text-sm leading-6 text-ink/70">
        Browse same-stock pools on Solana and Robinhood Chain, check the estimated fee APR (plus a
        backtested range on Solana), and open a position from your own wallet.
      </p>
      <Link
        href={APP_ROUTES.home}
        className="group mt-6 inline-flex h-12 items-center justify-between gap-4 rounded-full bg-ink pl-5 pr-1.5 text-sm font-semibold text-cream outline-none transition-transform hover:-translate-y-px focus-visible:shadow-[0_0_0_3px_var(--color-lilac)]"
      >
        Go to the app
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-lemon text-ink transition-transform group-hover:rotate-45">
          <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
        </span>
      </Link>
    </aside>
  );
}

export function BlogShell({ children }: { children: ReactNode }) {
  return (
    <InkShell>
      <InkNav />
      {children}
      <footer className="mt-6 flex flex-col gap-4 px-2 py-6 font-data text-[11px] uppercase tracking-[0.12em] text-smoke sm:flex-row sm:items-center sm:justify-between">
        <p>SoFinance · Self-custodial Raydium CLMM tool</p>
        <div className="flex flex-wrap items-center gap-5">
          <Link href={APP_ROUTES.home} className="transition-colors hover:text-cream">
            App
          </Link>
          <Link href={BLOG_ROUTES.home} className="transition-colors hover:text-cream">
            Blog
          </Link>
          <Link href={DOCS_ROUTES.home} className="transition-colors hover:text-cream">
            Docs
          </Link>
          <Link href={DOCS_ROUTES.risks} className="transition-colors hover:text-cream">
            Risks
          </Link>
          <a
            href={SOCIAL_LINKS.x.href}
            {...EXTERNAL_LINK_PROPS}
            aria-label={SOCIAL_LINKS.x.ariaLabel}
            className="inline-flex items-center gap-1.5 transition-colors hover:text-cream"
          >
            <XIcon className="h-3 w-3" />
            {SOCIAL_LINKS.x.label}
          </a>
        </div>
      </footer>
    </InkShell>
  );
}

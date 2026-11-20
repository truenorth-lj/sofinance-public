import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { InkShell } from "@/components/ink";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { APP_ROUTES } from "@/lib/public-urls";

export function BlogAppCta() {
  return (
    <aside className="mt-3 rounded-[28px] bg-cream p-6 text-ink sm:p-8">
      <h2 className="max-w-[16ch] text-[clamp(1.6rem,3vw,2.2rem)] font-medium leading-[1.08] tracking-[-0.03em]">
        Open the app
      </h2>
      <p className="mt-4 max-w-xl text-sm leading-6 text-ink/70">
        Browse same-stock pools on Solana and Robinhood Chain, compare ranges (on Solana, picked from the
        past 7 days of fee data), and open a position from your own wallet.
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
      <SiteHeader />
      {children}
      <SiteFooter variant="marketing" />
    </InkShell>
  );
}

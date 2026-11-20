import type { ReactNode } from "react";
import Link from "next/link";
import { XIcon } from "@/components/x-icon";
import { APP_ROUTES, BLOG_ROUTES, DOCS_ROUTES, FAQ_ROUTE, GUIDE_ROUTES, LEGAL_ROUTES, LLMS_TXT_ROUTE } from "@/lib/public-urls";
import { EXTERNAL_LINK_PROPS, SOCIAL_LINKS } from "@/lib/social-links";

export const SITE_TAGLINE = "Self-custodial liquidity on Solana and Robinhood Chain";
export const SITE_REGION_LINE = "Not available to US persons or restricted regions.";

const linkClass = "transition-colors hover:text-cream";

/**
 * One site footer. `variant` only hides Blog on app pages (11/4: Blog stays on the marketing site).
 * Tagline and the region line are the same everywhere.
 */
export function SiteFooter({ variant = "marketing" }: { variant?: "marketing" | "app" }) {
  const showBlog = variant === "marketing";
  return (
    <footer
      data-testid="site-footer"
      className="mt-10 flex flex-col gap-5 border-t border-white/10 px-1 py-6 font-data text-[11px] uppercase tracking-[0.12em] text-smoke"
    >
      <p>SoFinance · {SITE_TAGLINE}</p>
      <div className="flex flex-col gap-5 sm:flex-row sm:flex-wrap sm:gap-x-12 sm:gap-y-5">
        <FooterGroup label="Product">
          <Link href={APP_ROUTES.rwaPairs} className={linkClass}>Pools</Link>
          <Link href={APP_ROUTES.home} className={linkClass}>Portfolio</Link>
          <Link href={APP_ROUTES.ai} className={linkClass}>AI agents</Link>
        </FooterGroup>
        <FooterGroup label="Learn">
          <Link href={GUIDE_ROUTES.learn} className={linkClass}>Learn</Link>
          <Link href={DOCS_ROUTES.home} className={linkClass}>Docs</Link>
          <Link href={FAQ_ROUTE} className={linkClass}>FAQ</Link>
          <Link href={GUIDE_ROUTES.fees} className={linkClass}>Pricing</Link>
          {showBlog ? <Link href={BLOG_ROUTES.home} className={linkClass}>Blog</Link> : null}
        </FooterGroup>
        <FooterGroup label="Legal">
          <Link href={DOCS_ROUTES.risks} className={linkClass}>Risks</Link>
          <Link href={LEGAL_ROUTES.terms} className={linkClass}>Terms</Link>
        </FooterGroup>
        <nav aria-label="Elsewhere" className="flex flex-wrap items-center gap-5">
          <a
            href={SOCIAL_LINKS.x.href}
            {...EXTERNAL_LINK_PROPS}
            aria-label={SOCIAL_LINKS.x.ariaLabel}
            className={`inline-flex items-center gap-1.5 ${linkClass}`}
          >
            <XIcon className="h-3 w-3" />
            {SOCIAL_LINKS.x.label}
          </a>
          <a href={LLMS_TXT_ROUTE} className={linkClass} title="Plain-text summary for AI assistants">
            llms.txt
          </a>
        </nav>
      </div>
      <p>{SITE_REGION_LINE}</p>
    </footer>
  );
}

function FooterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <nav aria-label={label} className="flex flex-col gap-2">
      <p className="text-smoke/70">{label}</p>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">{children}</div>
    </nav>
  );
}

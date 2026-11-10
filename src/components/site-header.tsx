import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";
import { APP_ROUTES, BLOG_ROUTES } from "@/lib/public-urls";

const navPill =
  "flex h-10 items-center justify-center rounded-full border border-white/25 px-4 text-[13px] font-medium text-cream/85 outline-none transition-colors hover:border-white/70 focus-visible:border-lemon";

/**
 * Marketing-site header (homepage, blog, docs, FAQ, terms). On the homepage Pools is an in-page anchor; elsewhere it
 * points back to the homepage's pools list. AI agents opens the app's agent page. In-app pages use InkNav instead.
 */
export function SiteHeader({ onHomepage = false }: { onHomepage?: boolean }) {
  const section = (id: string) => (onHomepage ? `#${id}` : `/#${id}`);
  return (
    <header data-testid="site-header" className="flex flex-wrap items-center justify-between gap-2">
      <Link
        href="/"
        className="flex h-10 items-center gap-2 rounded-full bg-lemon pl-1.5 pr-4 text-[13px] font-semibold text-ink outline-none focus-visible:shadow-[0_0_0_2px_var(--color-cream)]"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ink">
          <BrandMark className="h-5 w-5 text-lemon" />
        </span>
        SoFinance
      </Link>
      {/* Below md the section links take their own full row (basis-full; flex-1 alone squeezed them beside the buttons). */}
      <nav aria-label="Sections" className="order-3 flex basis-full flex-wrap gap-2 md:order-none md:flex-1 md:basis-auto">
        <a href={section("pools")} className={`${navPill} flex-1`}>
          Pools
        </a>
        <Link href={APP_ROUTES.ai} className={`${navPill} hidden flex-1 sm:flex`}>
          AI agents
        </Link>
        <Link href={BLOG_ROUTES.home} className={`${navPill} flex-1`}>
          Blog
        </Link>
      </nav>
      <Link
        href={APP_ROUTES.home}
        className="flex h-10 items-center justify-center rounded-full bg-cream px-5 text-[13px] font-semibold text-ink outline-none transition-colors hover:bg-white focus-visible:shadow-[0_0_0_2px_var(--color-lemon)]"
      >
        Open app
      </Link>
    </header>
  );
}

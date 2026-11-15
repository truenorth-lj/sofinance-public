import Link from "next/link";
import type { ReactNode } from "react";
import { InkHero, InkShell } from "@/components/ink";
import { SiteHeader } from "@/components/site-header";
import { GUIDE_RISK_LINE, guideJsonLd, type GuideBlock, type GuidePage } from "@/lib/guides";
import { serializeJsonLd } from "@/lib/json-ld";
import { APP_ROUTES, DOCS_ROUTES, FAQ_ROUTE, GUIDE_ROUTES, LEGAL_ROUTES } from "@/lib/public-urls";

const card = "mt-3 rounded-[28px] border border-white/12 bg-char p-6 sm:p-8";
const footerLink = "transition-colors hover:text-cream";

function Block({ block }: { block: GuideBlock }) {
  if (block.kind === "p") return <p className="mt-2 text-sm leading-7 text-cream/85">{block.text}</p>;
  const items = block.items.map((item) => <li key={item}>{item}</li>);
  return block.kind === "ol" ? (
    <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-7 text-cream/85">{items}</ol>
  ) : (
    <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-7 text-cream/85">{items}</ul>
  );
}

/** Footer shared by the guide pages and the /learn index. */
export function GuideFooter() {
  return (
    <footer className="mt-6 flex flex-wrap items-center gap-5 px-2 py-4 font-data text-[11px] uppercase tracking-[0.12em] text-smoke">
      <Link href="/" className={footerLink}>Home</Link>
      <Link href={APP_ROUTES.rwaPairs} className={footerLink}>Pools</Link>
      <Link href={GUIDE_ROUTES.fees} className={footerLink}>Pricing</Link>
      <Link href={GUIDE_ROUTES.learn} className={footerLink}>Learn</Link>
      <Link href={DOCS_ROUTES.gettingStarted} className={footerLink}>Docs</Link>
      <Link href={FAQ_ROUTE} className={footerLink}>FAQ</Link>
      <Link href={LEGAL_ROUTES.terms} className={footerLink}>Terms of Service</Link>
    </footer>
  );
}

/** Server-rendered guide page: hero, one card per question (h2 + answer), related links, risk line, JSON-LD. */
export function GuideArticle({ page, children }: { page: GuidePage; children?: ReactNode }) {
  return (
    <InkShell>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(guideJsonLd(page)) }} />
      <SiteHeader />
      <main className="mt-3">
        <article>
          <InkHero label={page.heroLabel} title={page.title} stacked>
            <p>{page.intro}</p>
            <p className="mt-3 font-data text-[11px] uppercase tracking-[0.12em] text-ink/60">Updated {page.updated}</p>
          </InkHero>

          {page.qas.map((qa) => (
            <section key={qa.id} id={qa.id} aria-labelledby={`${qa.id}-title`} className={`${card} scroll-mt-6`}>
              <h2 id={`${qa.id}-title`} className="text-lg font-semibold tracking-[-0.02em] text-cream">
                {qa.question}
              </h2>
              {qa.blocks.map((block, index) => (
                <Block key={index} block={block} />
              ))}
            </section>
          ))}

          {children}

          <nav aria-label="Related pages" className={card}>
            <p className="font-data text-[10px] uppercase tracking-[0.14em] text-smoke">Related</p>
            <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
              {page.related.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-lemon underline underline-offset-2 hover:text-[#fff27f]">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <p className="mt-3 rounded-[28px] border border-white/12 bg-char px-6 py-5 text-sm leading-6 text-smoke sm:px-8">
            {GUIDE_RISK_LINE} Read the{" "}
            <Link href={DOCS_ROUTES.risks} className="text-cream underline underline-offset-2">risks</Link> before you open a position.
          </p>
        </article>
      </main>
      <GuideFooter />
    </InkShell>
  );
}

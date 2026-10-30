import Link from "next/link";
import { InkHero, InkNav, InkShell } from "@/components/ink";
import { FAQ_RISK_LINE, FAQ_SECTIONS, faqJsonLd } from "@/lib/faq";
import { serializeJsonLd } from "@/lib/json-ld";
import { APP_ROUTES, CANONICAL_SITE_URL, DOCS_ROUTES, FAQ_ROUTE, LEGAL_ROUTES } from "@/lib/public-urls";
import { pageMetadata } from "@/lib/seo";

export const dynamic = "force-static";

export const metadata = pageMetadata({
  title: "FAQ: LP fees, xStocks and tokenized stocks",
  description:
    "Plain answers on how liquidity providers collect trading fees, what xStocks, Backpack and Robinhood stock tokens are, how to buy stocks onchain, and where SoFinance fits.",
  path: FAQ_ROUTE,
});

export default function FaqPage() {
  return (
    <InkShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(faqJsonLd(`${CANONICAL_SITE_URL}${FAQ_ROUTE}`)) }}
      />
      <InkNav />
      <main className="mt-3">
        <InkHero label="FAQ" title="Questions about same-stock LP" stacked>
          <p>
            How liquidity providers collect trading fees, what tokenized stocks are, and where SoFinance fits.
            For step-by-step guides, see the <Link href={DOCS_ROUTES.gettingStarted} className="text-lemon underline underline-offset-2">docs</Link>.
          </p>
        </InkHero>

        {FAQ_SECTIONS.map((section) => (
          <section
            key={section.id}
            id={section.id}
            aria-labelledby={`${section.id}-title`}
            className="mt-3 scroll-mt-6 rounded-[28px] border border-white/12 bg-char p-6 sm:p-8"
          >
            <h2 id={`${section.id}-title`} className="text-lg font-semibold tracking-[-0.02em] text-cream">
              {section.title}
            </h2>
            <div className="mt-4 divide-y divide-white/10">
              {section.items.map((item) => (
                <div key={item.question} className="py-5 first:pt-0 last:pb-0">
                  <h3 className="text-[15px] font-medium text-cream">{item.question}</h3>
                  <p className="mt-2 text-sm leading-7 text-cream/85">{item.answer}</p>
                </div>
              ))}
            </div>
          </section>
        ))}

        <p className="mt-3 rounded-[28px] border border-white/12 bg-char px-6 py-5 text-sm leading-6 text-smoke sm:px-8">
          {FAQ_RISK_LINE} Read the <Link href={DOCS_ROUTES.risks} className="text-cream underline underline-offset-2">risks</Link>{" "}
          before you open a position.
        </p>
      </main>
      <footer className="mt-6 flex flex-wrap items-center gap-5 px-2 py-4 font-data text-[11px] uppercase tracking-[0.12em] text-smoke">
        <Link href="/" className="transition-colors hover:text-cream">Home</Link>
        <Link href={APP_ROUTES.rwaPairs} className="transition-colors hover:text-cream">Pools</Link>
        <Link href={DOCS_ROUTES.gettingStarted} className="transition-colors hover:text-cream">Docs</Link>
        <Link href={LEGAL_ROUTES.terms} className="transition-colors hover:text-cream">Terms of Service</Link>
      </footer>
    </InkShell>
  );
}

import Link from "next/link";
import { InkShell } from "@/components/ink";
import { PageHeader } from "@/components/page-header";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { FAQ_RISK_LINE, FAQ_SECTIONS, faqJsonLd } from "@/lib/faq";
import { serializeJsonLd } from "@/lib/json-ld";
import { CANONICAL_SITE_URL, DOCS_ROUTES, FAQ_ROUTE } from "@/lib/public-urls";
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
      <SiteHeader />
      <main id="main">
        <PageHeader
          title="Questions about same-stock LP"
          subline={
            <>
              How liquidity providers collect trading fees, what tokenized stocks are, and where SoFinance fits.
              For step-by-step guides, see the <Link href={DOCS_ROUTES.gettingStarted} className="text-lemon underline underline-offset-2">docs</Link>.
            </>
          }
        />

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
      <SiteFooter variant="marketing" />
    </InkShell>
  );
}

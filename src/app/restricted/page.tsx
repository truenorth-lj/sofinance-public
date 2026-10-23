import Link from "next/link";
import type { Metadata } from "next";
import { InkHero, InkNav, InkShell } from "@/components/ink";
import { RESTRICTED_REGION_LABELS } from "@/lib/restricted-regions";
import { EXIT_APP_PATH } from "@/lib/region-routes";
import { RAYDIUM_PORTFOLIO_URL, REGION_BLOCKED_COPY as copy } from "@/lib/region/blocked-copy";
import { DOCS_ROUTES } from "@/lib/public-urls";

export const metadata: Metadata = {
  title: "Not available in your region · SoFinance",
  robots: { index: false },
};

export default function RestrictedPage() {
  return <InkShell>
    <InkNav />
    <InkHero label="Restricted region" title={copy.title}>{copy.body}</InkHero>
    <div className="mt-3 grid gap-3 lg:grid-cols-2">
      <section aria-labelledby="exit-heading" className="rounded-[28px] bg-lemon p-6 text-ink sm:p-8">
        <h2 id="exit-heading" className="text-xl font-medium tracking-[-0.02em]">{copy.exitHeading}</h2>
        <p className="mt-3 text-sm leading-6 text-ink/75">{copy.exitBody}</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href={EXIT_APP_PATH} className="inline-flex h-11 items-center rounded-full bg-ink px-5 text-sm font-semibold text-cream">{copy.exitAction}</Link>
          <a href={RAYDIUM_PORTFOLIO_URL} target="_blank" rel="noreferrer" className="inline-flex h-11 items-center rounded-full border border-ink/40 px-5 text-sm font-semibold text-ink hover:border-ink">{copy.raydiumAction}</a>
        </div>
      </section>
      <section aria-labelledby="tips-heading" className="rounded-[28px] border border-white/12 bg-char p-6 sm:p-8">
        <h2 id="tips-heading" className="text-xl font-medium tracking-[-0.02em] text-cream">{copy.whatYouCanDo}</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-smoke">
          {copy.tips.map((tip) => <li key={tip}>{tip}</li>)}
        </ul>
      </section>
    </div>
    <section aria-labelledby="regions-heading" className="mt-3 rounded-[28px] border border-white/12 bg-char p-6 text-sm leading-6 text-smoke sm:p-8">
      <h2 id="regions-heading" className="text-base font-semibold text-cream">Restricted regions</h2>
      <p className="mt-2">Opening, adding to and compounding positions is not available to residents of, or people located in:</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {RESTRICTED_REGION_LABELS.map((label) => <li key={label}>{label}</li>)}
      </ul>
      <p className="mt-4">Using a VPN or any other means to get around this restriction is not permitted. See the <Link href="/terms" className="text-cream underline underline-offset-4">Terms of Service</Link>. You can still read the <Link href={DOCS_ROUTES.home} className="text-cream underline underline-offset-4">Docs</Link>.</p>
    </section>
  </InkShell>;
}

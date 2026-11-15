import Link from "next/link";
import { GuideFooter } from "@/components/guides/guide-article";
import { InkHero, InkShell } from "@/components/ink";
import { SiteHeader } from "@/components/site-header";
import { GUIDE_PAGES, LEARN_INDEX, type GuideKind } from "@/lib/guides";
import { pageMetadata } from "@/lib/seo";

export const dynamic = "force-static";

export const metadata = pageMetadata({ title: LEARN_INDEX.metaTitle, description: LEARN_INDEX.metaDescription, path: LEARN_INDEX.path });

const GROUPS: { kind: GuideKind; title: string }[] = [
  { kind: "learn", title: "Beginner guides" },
  { kind: "use-case", title: "Use cases" },
  { kind: "pricing", title: "Pricing" },
];

export default function LearnIndexPage() {
  return (
    <InkShell>
      <SiteHeader />
      <main className="mt-3">
        <InkHero label="Learn" title="Same-stock LP, explained" stacked>
          <p>Short guides that answer the common questions first: what a same-stock pool is, how to open a position, impermanent loss, pricing, and worked use cases.</p>
        </InkHero>
        {GROUPS.map((group) => (
          <section key={group.kind} aria-labelledby={`${group.kind}-title`} className="mt-3 rounded-[28px] border border-white/12 bg-char p-6 sm:p-8">
            <h2 id={`${group.kind}-title`} className="text-lg font-semibold tracking-[-0.02em] text-cream">{group.title}</h2>
            <ul className="mt-4 divide-y divide-white/10">
              {GUIDE_PAGES.filter((page) => page.kind === group.kind).map((page) => (
                <li key={page.path} className="py-4 first:pt-0 last:pb-0">
                  <Link href={page.path} className="text-[15px] font-medium text-cream underline-offset-2 hover:underline">{page.title}</Link>
                  <p className="mt-1 text-sm leading-6 text-cream/75">{page.metaDescription}</p>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </main>
      <GuideFooter />
    </InkShell>
  );
}

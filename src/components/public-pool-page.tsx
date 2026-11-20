import Link from "next/link";
import { SiteFooter } from "@/components/site-footer";
import { InkShell } from "@/components/ink";
import { PageHeader } from "@/components/page-header";
import { SiteHeader } from "@/components/site-header";
import { DOCS_ROUTES, GUIDE_ROUTES } from "@/lib/public-urls";
import { HOMEPAGE_APR_DOCS_LINK_LABEL } from "@/lib/apr-labels/copy";
import { PUBLIC_POOL_APR_LABEL, type PublicPoolPageModel } from "@/lib/public-pool-pages";
import { PUBLIC_POOLS_H1 } from "@/lib/public-pools-table";

function Fact({ term, value }: { term: string; value: string }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-x-4 border-b border-white/10 py-3 sm:grid-cols-[10rem_1fr]">
      <dt className="text-sm text-cream/70">{term}</dt>
      <dd className="text-sm text-cream">{value}</dd>
    </div>
  );
}

/** Server-rendered public pool page: facts from the cached snapshot, no per-request RPC. */
export function PublicPoolPage({ model }: { model: PublicPoolPageModel }) {
  return (
    <InkShell>
      <SiteHeader />
      <main className="mt-3">
        <nav aria-label="Breadcrumb" className="mb-3 text-sm text-cream/70">
          <ol className="flex flex-wrap items-center gap-2">
            <li><Link href="/" className="underline decoration-cream/40 underline-offset-2 hover:decoration-cream">Home</Link></li>
            <li aria-hidden="true">/</li>
            <li>
              <Link href={model.listHref} className="underline decoration-cream/40 underline-offset-2 hover:decoration-cream">
                {PUBLIC_POOLS_H1}
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li className="text-cream">{model.title}</li>
          </ol>
        </nav>
        <PageHeader title={model.title} subline={model.aprHelp} />
        <section aria-labelledby="pool-facts-heading" className="mt-3 rounded-[28px] border border-white/12 bg-char p-6 sm:p-8">
          <h2 id="pool-facts-heading" className="text-lg font-semibold tracking-[-0.02em] text-cream">Pool facts</h2>
          <dl className="mt-4">
            <Fact term="Pair" value={model.pairLabel} />
            <Fact term="Chain" value={model.chain} />
            <Fact term="DEX" value={model.dex} />
            <Fact term="Fee tier" value={model.feeTier} />
            <Fact term="TVL" value={model.tvl} />
            <Fact term="24h volume" value={model.volume24h} />
            <Fact term={PUBLIC_POOL_APR_LABEL} value={model.apr7d} />
          </dl>
          <p className="mt-6 text-sm">
            <Link href={model.openInAppHref} className="underline decoration-cream/40 underline-offset-2 hover:decoration-cream">
              Open this pool in the app
            </Link>
            {" · "}
            <Link href={model.listHref} className="underline decoration-cream/40 underline-offset-2 hover:decoration-cream">
              All same-stock pools
            </Link>
            {" · "}
            <Link href={GUIDE_ROUTES.learn} className="underline decoration-cream/40 underline-offset-2 hover:decoration-cream">
              Learn
            </Link>
            {" · "}
            <Link href={DOCS_ROUTES.feeApr} className="underline decoration-cream/40 underline-offset-2 hover:decoration-cream">
              {HOMEPAGE_APR_DOCS_LINK_LABEL}
            </Link>
          </p>
        </section>
      </main>
      <SiteFooter variant="marketing" />
    </InkShell>
  );
}

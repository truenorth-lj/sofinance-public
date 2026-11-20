import Link from "next/link";
import { SiteFooter } from "@/components/site-footer";
import { InkShell } from "@/components/ink";
import { PageHeader } from "@/components/page-header";
import { SiteHeader } from "@/components/site-header";
import { cn } from "@/lib/cn";
import { DOCS_ROUTES, GUIDE_ROUTES, buildCalculatePath } from "@/lib/public-urls";
import { HOMEPAGE_APR_DOCS_LINK_LABEL } from "@/lib/apr-labels/copy";
import { PUBLIC_POOL_APR_LABEL, type PublicPoolPageModel } from "@/lib/public-pool-pages";
import { PUBLIC_POOLS_H1 } from "@/lib/public-pools-table";
import { openAction } from "@/lib/unified-pools/open-action";
import { NOT_SUPPORTED_LABEL } from "@/lib/unified-pools/model";
import { poolSupportsCalculator } from "@/lib/unified-pools/plan-support";

function Fact({ term, value }: { term: string; value: string }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-x-4 border-b border-white/10 py-3 sm:grid-cols-[10rem_1fr]">
      <dt className="text-sm text-cream/70">{term}</dt>
      <dd className="text-sm text-cream">{value}</dd>
    </div>
  );
}

const pill =
  "inline-flex h-11 min-h-11 items-center justify-center rounded-full px-4 text-sm font-semibold outline-none focus-visible:shadow-[0_0_0_3px_var(--color-lilac)]";
const openPill = cn(pill, "bg-lemon text-ink transition-colors hover:bg-[#fff27f]");
const calcPill = cn(pill, "border border-white/30 text-cream transition-colors hover:border-cream");

function OpenPositionControl({ model }: { model: PublicPoolPageModel }) {
  const action = openAction(model.pool);
  const label = model.pairLabel;
  if (action.kind === "link") {
    return (
      <Link href={action.href} className={openPill} aria-label={`Open position in ${label}`}>
        Open position
      </Link>
    );
  }
  if (action.kind === "disabled") {
    return (
      <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="open-disabled">
        <button type="button" disabled aria-disabled="true" title={action.reason}
          aria-label={`Open position in ${label}: ${action.reason}`}
          className={cn(openPill, "cursor-not-allowed opacity-45 hover:bg-lemon")}>
          Open position
        </button>
        <span className="text-xs text-cream/70">{action.reason}</span>
      </span>
    );
  }
  if (action.kind === "unsupported") {
    return (
      <span data-testid="open-unsupported" aria-disabled="true" title={action.reason}
        className="inline-flex h-11 cursor-not-allowed items-center gap-1.5 rounded-full border border-white/20 px-4 text-sm font-semibold text-cream/60">
        <span>{NOT_SUPPORTED_LABEL}</span>
        <span className="sr-only">: {action.reason}</span>
      </span>
    );
  }
  if (action.kind === "none") return <span className="text-xs text-cream/70">{action.reason}</span>;
  return null;
}

/** Server-rendered public pool page: facts from the cached snapshot, no per-request RPC. */
export function PublicPoolPage({ model }: { model: PublicPoolPageModel }) {
  const showCalculate = poolSupportsCalculator(model.pool);
  return (
    <InkShell>
      <SiteHeader />
      <main id="main" className="mt-3">
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
        <PageHeader title={model.title} subline={`${model.chain} · ${model.dex} · ${model.feeTier} fee tier`} />
        <div className="mt-4 flex flex-wrap items-center gap-3" data-testid="pool-page-actions">
          <OpenPositionControl model={model} />
          {showCalculate && (
            <Link
              href={buildCalculatePath(model.pool.poolAddress)}
              className={calcPill}
              aria-label={`Calculate shares for ${model.pairLabel}`}
            >
              Calculate shares
            </Link>
          )}
        </div>
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
          <p className="mt-3 text-sm leading-6 text-cream/70" data-testid="apr-help">{model.aprHelp}</p>
          <p className="mt-6 text-sm">
            <Link href={model.listHref} className="underline decoration-cream/40 underline-offset-2 hover:decoration-cream">
              All pools
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

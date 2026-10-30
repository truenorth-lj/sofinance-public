import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { BrandMark } from "@/components/brand-mark";
import { HomepagePoolsTable, HomepagePoolsView } from "@/components/homepage-pools-table";
import type { HomepagePoolsSnapshot } from "@/lib/homepage-pools";
import { ArrowUpRight } from "lucide-react";
import { APP_ROUTES, BLOG_ROUTES, DOCS_ROUTES, FAQ_ROUTE, LEGAL_ROUTES, LLMS_TXT_ROUTE } from "@/lib/public-urls";
import { EXTERNAL_LINK_PROPS, SOCIAL_LINKS } from "@/lib/social-links";
import { XIcon } from "@/components/x-icon";

const navPill =
  "flex h-10 items-center justify-center rounded-full border border-white/25 px-4 text-[13px] font-medium text-cream/85 outline-none transition-colors hover:border-white/70 focus-visible:border-lemon";
const labelPill =
  "inline-flex h-6 items-center whitespace-nowrap rounded-full border px-2.5 font-data text-[10px] uppercase tracking-[0.14em]";
const darkCard = "rounded-[28px] border border-white/12 bg-char p-6 sm:p-7";

function ArrowCta({
  href,
  tone,
  children,
}: {
  href: string;
  tone: "ink" | "lemon" | "outline-ink" | "outline";
  children: ReactNode;
}) {
  const tones = {
    ink: "bg-ink text-cream",
    lemon: "bg-lemon text-ink",
    "outline-ink": "border border-ink/40 text-ink hover:border-ink",
    outline: "border border-white/30 text-cream hover:border-cream",
  } as const;
  const knobs = {
    ink: "bg-lemon text-ink",
    lemon: "bg-ink text-lemon",
    "outline-ink": "bg-ink text-cream",
    outline: "bg-cream text-ink",
  } as const;
  const className = `group inline-flex h-12 items-center justify-between gap-4 rounded-full pl-5 pr-1.5 text-sm font-semibold outline-none transition-[transform,border-color] hover:-translate-y-px focus-visible:shadow-[0_0_0_3px_var(--color-lilac)] ${tones[tone]}`;
  const inner = (
    <>
      {children}
      <span
        className={`flex h-9 w-9 items-center justify-center rounded-full transition-transform group-hover:rotate-45 ${knobs[tone]}`}
      >
        <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
      </span>
    </>
  );
  if (href.startsWith("#")) {
    return (
      <a href={href} className={className}>
        {inner}
      </a>
    );
  }
  return (
    <Link href={href} className={className}>
      {inner}
    </Link>
  );
}

function SectionHeading({ label, children }: { label: string; children: string }) {
  return (
    <div className="mb-3 flex flex-col gap-4 px-2 pt-14 sm:pt-20">
      <span className={`${labelPill} w-fit border-white/30 text-cream/80`}>{label}</span>
      <h2 className="max-w-3xl text-[clamp(1.7rem,3.4vw,2.75rem)] font-medium leading-[1.08] tracking-[-0.035em]">
        {children}
      </h2>
    </div>
  );
}

export function LandingPage({ initialPools = null }: { initialPools?: HomepagePoolsSnapshot | null } = {}) {
  return (
    <div className="min-h-screen overflow-x-clip bg-canvas text-cream">
      <div className="mx-auto max-w-[1280px] px-3 pb-10 pt-3 sm:px-5 sm:pt-5">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <Link
            href="/"
            className="flex h-10 items-center gap-2 rounded-full bg-lemon pl-1.5 pr-4 text-[13px] font-semibold text-ink outline-none focus-visible:shadow-[0_0_0_2px_var(--color-cream)]"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ink">
              <BrandMark className="h-5 w-5 text-lemon" />
            </span>
            SoFinance
          </Link>
          <nav aria-label="Sections" className="order-3 flex w-full flex-1 flex-wrap gap-2 md:order-none md:w-auto">
            <a href="#pools" className={`${navPill} flex-1`}>
              Pools
            </a>
            <a href="#how" className={`${navPill} flex-1`}>
              How it works
            </a>
            <a href="#agents" className={`${navPill} hidden flex-1 sm:flex`}>
              AI agents
            </a>
            <Link href={DOCS_ROUTES.home} className={`${navPill} flex-1`}>
              Docs
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

        <main>
          <section className="mt-3 animate-rise rounded-[28px] bg-cream p-6 text-ink motion-reduce:animate-none sm:p-10">
            <span className={`${labelPill} border-ink/70`}>Self-custodial · Solana + Robinhood Chain</span>
            <h1 className="mt-6 max-w-[18ch] text-[clamp(2.1rem,5.4vw,4.4rem)] font-medium leading-[1.02] tracking-[-0.045em]">
              Hold the stock. Collect the fees.
            </h1>
            <div className="mt-6 border-t border-ink/20 pt-5">
              <p className="max-w-2xl text-base leading-7 text-ink/70 sm:text-lg">
                Your $TSLA, $MSTR or $SPCX tokens can collect trading fees from swaps in Raydium (Solana) and Uniswap v4 (Robinhood Chain) pools. We show the estimated fee APR and a 7-day backtest before you sign. Not guaranteed; risks apply.
              </p>
              <p className="mt-4 font-data text-[11px] uppercase tracking-[0.12em] text-ink/55">
                0 keys on our servers · verifiable on Solscan and Blockscout
              </p>
              <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
                <ArrowCta href="#pools" tone="ink">
                  Browse pools
                </ArrowCta>
                <Link
                  href={APP_ROUTES.home}
                  className="text-sm font-semibold text-ink/70 underline-offset-2 hover:text-ink hover:underline"
                >
                  Already have a position? Manage it →
                </Link>
              </div>
            </div>
          </section>

          {/* The fallback is what prerendered HTML contains (useSearchParams bails out to the client), so it renders
              the server snapshot: crawlers see pool names and stats, not "Loading pool data…". */}
          <Suspense fallback={<HomepagePoolsView initial={initialPools} />}>
            <HomepagePoolsTable initial={initialPools} />
          </Suspense>

          <section id="how" className="scroll-mt-6">
            <SectionHeading label="How it works">Three steps. Your wallet signs.</SectionHeading>
            <ol className="grid gap-3 md:grid-cols-3">
              {[
                {
                  n: "01",
                  title: "Pick a pool",
                  body: "Choose a same-stock pool on Solana or Robinhood Chain and a price range. On Solana the app suggests the best backtest range; you can override it. Est. fee APR is shown before you sign — not guaranteed.",
                },
                {
                  n: "02",
                  title: "Review the preview",
                  body: "See the swap, the amounts and the fees before you sign. On Solana the preview also shows the total round-trip cost.",
                },
                {
                  n: "03",
                  title: "Sign in your wallet",
                  body: "Solana: one signature opens the position; later you can add, compound fees or exit. Robinhood Chain: a one-time token approval, a signature, then one transaction; you can close it here later.",
                },
              ].map((step) => (
                <li key={step.n} className={`${darkCard} flex flex-col`}>
                  <p className="font-data text-[2.5rem] leading-none tracking-[-0.04em] text-lemon">{step.n}</p>
                  <h3 className="mt-8 text-lg font-medium tracking-[-0.02em]">{step.title}</h3>
                  <p className="mt-2 border-t border-white/15 pt-3 text-sm leading-6 text-smoke">{step.body}</p>
                </li>
              ))}
            </ol>
          </section>

          <section>
            <SectionHeading label="Your keys, your position">
              Non-custodial. A standard position NFT in your wallet.
            </SectionHeading>
            <div className="grid gap-3 md:grid-cols-3">
              <article className="rounded-[28px] bg-cream p-6 text-ink sm:p-7">
                <h3 className="text-xl font-medium tracking-[-0.02em]">You hold the keys</h3>
                <p className="mt-3 border-t border-ink/20 pt-3 text-sm leading-6 text-ink/70">
                  SoFinance never holds your keys or your funds. You sign every transaction in your own
                  wallet.
                </p>
              </article>
              <article className="rounded-[28px] bg-mint p-6 text-ink sm:p-7">
                <h3 className="text-xl font-medium tracking-[-0.02em]">Verifiable on Solscan and Blockscout</h3>
                <p className="mt-3 border-t border-ink/25 pt-3 text-sm leading-6 text-ink/75">
                  Every confirmed transaction is public. Open it on Solscan (Solana) or Blockscout (Robinhood
                  Chain) to inspect what moved.
                </p>
              </article>
              <article className={darkCard}>
                <h3 className="text-xl font-medium tracking-[-0.02em]">Portable position</h3>
                <p className="mt-3 border-t border-white/15 pt-3 text-sm leading-6 text-smoke">
                  Opening a position puts a standard position NFT in your wallet: a Raydium position NFT on
                  Solana, a Uniswap v4 position NFT on Robinhood Chain. Manage it here; Raydium positions can
                  also be managed directly on Raydium.
                </p>
              </article>
            </div>
          </section>

          <section>
            <SectionHeading label="Risks">What the numbers do not cover</SectionHeading>
            <article className={`${darkCard} sm:p-8`}>
              <ul className="grid gap-4 text-sm leading-6 text-smoke sm:grid-cols-2">
                <li>
                  <strong className="font-medium text-cream">Est. fee APR is not guaranteed.</strong> It is
                  recent pool fees divided by TVL, annualized (last 24h, or a 7-day backtest for a range) — not
                  LP return.
                </li>
                <li>
                  <strong className="font-medium text-cream">Out of range means no fees.</strong> If the
                  pool price leaves your range, that position collects nothing until price returns or you
                  change range.
                </li>
                <li>
                  <strong className="font-medium text-cream">Impermanent loss.</strong> Versus holding the
                  tokens, LP can underperform when the two sides move apart.
                </li>
                <li>
                  <strong className="font-medium text-cream">Issuer controls.</strong> On Solana, xStock
                  issuers may retain Token-2022 freeze or other controls that can block transfers. Each
                  Robinhood Chain pool pairs a Robinhood stock token with the Ondo token of the same stock, so
                  it depends on both issuers.
                </li>
              </ul>
              <p className="mt-6 border-t border-white/15 pt-4 text-sm text-smoke">
                Read the full list in{" "}
                <Link href={DOCS_ROUTES.risks} className="text-cream underline underline-offset-2">
                  Risks
                </Link>
                .
              </p>
            </article>
          </section>

          <section id="agents" className="scroll-mt-6">
            <SectionHeading label="AI agents">Your agent prepares. Your wallet approves.</SectionHeading>
            <article className="rounded-[28px] bg-lilac p-6 text-ink sm:p-8">
              <p className="max-w-2xl text-sm leading-6 text-ink/75 sm:text-base">
                Connect an MCP client so an assistant can list pools, quote, and prepare an unsigned
                transaction. Only your wallet can approve it. Technical details live in Docs.
              </p>
              <div className="mt-6">
                <ArrowCta href={APP_ROUTES.ai} tone="ink">
                  Connect an agent
                </ArrowCta>
              </div>
            </article>
          </section>

          <p className="mt-10 px-2 text-sm text-smoke">Next: range re-centering, rebalancing.</p>

          <section className="mt-8 rounded-[28px] bg-cream p-8 text-ink sm:mt-12 sm:p-12">
            <h2 className="max-w-[16ch] text-[clamp(2rem,5vw,3.6rem)] font-medium leading-[1.02] tracking-[-0.04em]">
              Pick a pool. Your wallet signs.
            </h2>
            <div className="mt-8 flex flex-col gap-6 border-t border-ink/20 pt-6 md:flex-row md:items-center md:justify-between">
              <p className="max-w-xl text-sm leading-6 text-ink/70 sm:text-base">
                Browse live tokenized-stock pools on Solana and Robinhood Chain, or manage a position you already hold. Self-custodial throughout.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <ArrowCta href="#pools" tone="ink">
                  Browse pools
                </ArrowCta>
                <ArrowCta href={APP_ROUTES.home} tone="outline-ink">
                  Manage a position
                </ArrowCta>
              </div>
            </div>
          </section>
        </main>

        <footer className="mt-6 flex flex-col gap-4 px-2 py-6 font-data text-[11px] uppercase tracking-[0.12em] text-smoke sm:flex-row sm:items-center sm:justify-between">
          <p>SoFinance · Self-custodial liquidity on Solana and Robinhood Chain</p>
          <div className="flex flex-wrap items-center gap-5">
            <Link href={APP_ROUTES.home} className="transition-colors hover:text-cream">
              App
            </Link>
            <Link href={BLOG_ROUTES.home} className="transition-colors hover:text-cream">
              Blog
            </Link>
            <Link href={DOCS_ROUTES.home} className="transition-colors hover:text-cream">
              Docs
            </Link>
            <Link href={FAQ_ROUTE} className="transition-colors hover:text-cream">
              FAQ
            </Link>
            <Link href={DOCS_ROUTES.risks} className="transition-colors hover:text-cream">
              Risks
            </Link>
            <Link href={LEGAL_ROUTES.terms} className="transition-colors hover:text-cream">
              Terms
            </Link>
            <a href={LLMS_TXT_ROUTE} className="transition-colors hover:text-cream" title="Plain-text summary for AI assistants">
              llms.txt
            </a>
            <a
              href={SOCIAL_LINKS.x.href}
              {...EXTERNAL_LINK_PROPS}
              aria-label={SOCIAL_LINKS.x.ariaLabel}
              className="inline-flex items-center gap-1.5 transition-colors hover:text-cream"
            >
              <XIcon className="h-3 w-3" />
              {SOCIAL_LINKS.x.label}
            </a>
          </div>
        </footer>
      </div>
    </div>
  );
}

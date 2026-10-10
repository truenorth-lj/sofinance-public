import Link from "next/link";
import type { ReactNode } from "react";
import { BrandMark } from "@/components/brand-mark";
import {
  BookOpen,
  Wallet,
  Layers,
  Sprout,
  CalendarClock,
  Scale,
  MoveHorizontal,
  Coins,
  ArrowUpRight,
} from "lucide-react";
import { APP_ROUTES } from "@/lib/public-urls";

const GITHUB_URL = "https://github.com/truenorth-lj/sofinance-public";

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
  return (
    <Link
      href={href}
      className={`group inline-flex h-12 items-center justify-between gap-4 rounded-full pl-5 pr-1.5 text-sm font-semibold outline-none transition-[transform,border-color] hover:-translate-y-px focus-visible:shadow-[0_0_0_3px_var(--color-lilac)] ${tones[tone]}`}
    >
      {children}
      <span
        className={`flex h-9 w-9 items-center justify-center rounded-full transition-transform group-hover:rotate-45 ${knobs[tone]}`}
      >
        <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
      </span>
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

export function LandingPage() {
  return (
    <div className="min-h-screen bg-canvas text-cream">
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
          <nav aria-label="Sections" className="hidden flex-1 gap-2 md:flex">
            <a href="#toolkit" className={`${navPill} flex-1`}>
              Toolkit
            </a>
            <a href="#how" className={`${navPill} flex-1`}>
              How it works
            </a>
            <a href="#scenarios" className={`${navPill} flex-1`}>
              Scenarios
            </a>
            <Link href={APP_ROUTES.ai} className={`${navPill} flex-1`}>
              Use with AI
            </Link>
          </nav>
          <Link
            href={APP_ROUTES.home}
            className="flex h-10 items-center justify-center rounded-full bg-cream px-5 text-[13px] font-semibold text-ink outline-none transition-colors hover:bg-white focus-visible:shadow-[0_0_0_2px_var(--color-lemon)]"
          >
            Launch App
          </Link>
        </header>

        <main>
          <section className="mt-3 grid gap-3 lg:grid-cols-12">
            <div className="animate-rise rounded-[28px] bg-cream p-6 text-ink motion-reduce:animate-none sm:p-10 lg:col-span-8">
              <span className={`${labelPill} border-ink/70`}>Solana · Raydium CLMM</span>
              <h1 className="mt-8 max-w-[14ch] text-[clamp(2.6rem,7vw,5.6rem)] font-medium leading-[0.98] tracking-[-0.045em]">
                Strategy recipes for AI agents and humans
              </h1>
              <div className="mt-8 border-t border-ink/20 pt-6">
                <p className="max-w-xl text-base leading-7 text-ink/70 sm:text-lg">
                  SoFinance turns multi-step Solana LP strategies into simulated, one-signature recipes
                  — any AI agent can propose them, only your wallet can approve them.
                </p>
                <div className="mt-7 flex flex-wrap items-center gap-3">
                  <ArrowCta href={APP_ROUTES.home} tone="ink">
                    Launch App
                  </ArrowCta>
                  <ArrowCta href={APP_ROUTES.ai} tone="outline-ink">
                    Use with AI
                  </ArrowCta>
                  <a
                    href={GITHUB_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="px-2 text-sm text-ink/60 underline underline-offset-4 transition-colors hover:text-ink"
                  >
                    Source on GitHub
                  </a>
                </div>
              </div>
            </div>

            <div
              style={{ animationDelay: "90ms" }}
              className="relative flex min-h-[22rem] animate-rise flex-col overflow-hidden rounded-[28px] border border-white/12 bg-char p-6 motion-reduce:animate-none sm:p-7 lg:col-span-4 lg:row-span-2"
            >
              <span className={`${labelPill} w-fit border-white/30 text-cream/80`}>Non-custodial</span>
              <div aria-hidden="true" className="relative mx-auto my-8 flex aspect-square w-full max-w-[17rem] items-center justify-center">
                <span className="absolute inset-0 rounded-full border border-white/10" />
                <span className="absolute inset-[13%] rounded-full border border-white/15" />
                <span className="absolute inset-[27%] rounded-full border border-dashed border-lemon/50" />
                <span className="absolute left-[6%] top-[22%] h-3 w-3 rounded-full bg-mint" />
                <span className="absolute bottom-[12%] right-[16%] h-2.5 w-2.5 rounded-full bg-lilac" />
                <BrandMark className="h-28 w-28 text-lemon" />
              </div>
              <div className="mt-auto">
                <div className="flex items-baseline justify-between gap-3 border-b border-white/15 pb-3">
                  <h2 className="text-2xl font-medium tracking-[-0.03em]">Sign once</h2>
                  <span className="font-data text-xs text-smoke">v0 tx</span>
                </div>
                <p className="mt-4 text-sm leading-6 text-smoke">
                  Each recipe is quoted, built and simulated as one unsigned transaction. The agent never holds a key
                  and the server never takes custody.
                </p>
                <div className="mt-5 flex flex-wrap gap-1.5">
                  {["Quote", "Simulate", "Permit", "Re-simulate"].map((tag) => (
                    <span key={tag} className={`${labelPill} border-white/25 text-cream/70`}>
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div
              style={{ animationDelay: "160ms" }}
              className="flex animate-rise flex-col rounded-[28px] bg-lemon p-6 text-ink motion-reduce:animate-none lg:col-span-4"
            >
              <span className={`${labelPill} w-fit border-ink/70`}>Per recipe</span>
              <p className="mt-10 text-[clamp(3.5rem,7vw,5.5rem)] font-semibold leading-none tracking-[-0.05em]">1</p>
              <p className="mt-3 border-t border-ink/25 pt-3 text-sm leading-snug">
                Wallet signature, after a full simulation you can read first.
              </p>
            </div>
            <div
              style={{ animationDelay: "230ms" }}
              className="flex animate-rise flex-col rounded-[28px] bg-mint p-6 text-ink motion-reduce:animate-none lg:col-span-4"
            >
              <span className={`${labelPill} w-fit border-ink/70`}>Your keys, server-side</span>
              <p className="mt-10 text-[clamp(3.5rem,7vw,5.5rem)] font-semibold leading-none tracking-[-0.05em]">0</p>
              <p className="mt-3 border-t border-ink/25 pt-3 text-sm leading-snug">
                Agents get unsigned transactions and a sign link. Only your wallet signs for your funds.
              </p>
            </div>
          </section>

          <section>
            <SectionHeading label="The problem">
              Multi-step LP work is easy to get wrong when you assemble it by hand
            </SectionHeading>
            <div className="grid gap-3 md:grid-cols-2">
              <article className={darkCard}>
                <h3 className="text-xl font-medium tracking-[-0.02em]">Fragile, one-off transaction code</h3>
                <p className="mt-3 text-sm leading-6 text-smoke">
                  Agents and operators often rebuild Jupiter swaps, Raydium CLMM deposits, and
                  harvest-and-reinvest flows as ad-hoc scripts. Those paths skip a shared simulation
                  and the checks that belong with a real submit.
                </p>
              </article>
              <article className={darkCard}>
                <h3 className="text-xl font-medium tracking-[-0.02em]">Complex operations, many steps</h3>
                <p className="mt-3 text-sm leading-6 text-smoke">
                  A single compound or zap is several on-chain actions: quote, route, size to the
                  range, simulate, then sign. Rewriting that each time is how unsigned messages
                  drift and failed submits show up in the wallet.
                </p>
              </article>
            </div>
          </section>

          <section id="toolkit" className="scroll-mt-6">
            <SectionHeading label="The toolkit">Three pillars</SectionHeading>
            <div className="grid gap-3 lg:grid-cols-3">
              <article className="rounded-[28px] bg-cream p-6 text-ink sm:p-7">
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-ink text-cream">
                  <BookOpen className="h-5 w-5" aria-hidden="true" />
                </span>
                <h3 className="mt-10 text-2xl font-medium tracking-[-0.03em]">Recipes, not primitives</h3>
                <p className="mt-3 border-t border-ink/20 pt-3 text-sm leading-6 text-ink/70">
                  Compound, zap, open a new CLMM position, position performance, and RWA pair
                  discovery are tested, simulated multi-step flows. Agents call a recipe instead of
                  hand-assembling swap plus liquidity instructions.
                </p>
              </article>
              <article className="rounded-[28px] bg-lilac p-6 text-ink sm:p-7">
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-ink text-lilac">
                  <Wallet className="h-5 w-5" aria-hidden="true" />
                </span>
                <h3 className="mt-10 text-2xl font-medium tracking-[-0.03em]">Agent proposes, wallet approves</h3>
                <p className="mt-3 border-t border-ink/20 pt-3 text-sm leading-6 text-ink/70">
                  The agent never holds a key. The server never takes custody. Each action is an
                  unsigned transaction you sign once in your wallet, then the server re-simulates
                  before sending.
                </p>
              </article>
              <article className={darkCard}>
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-cream text-ink">
                  <Layers className="h-5 w-5" aria-hidden="true" />
                </span>
                <h3 className="mt-10 text-2xl font-medium tracking-[-0.03em]">One engine, two surfaces</h3>
                <p className="mt-3 border-t border-white/15 pt-3 text-sm leading-6 text-smoke">
                  The web UI and the MCP server share the same logic and safety gates, so a human
                  can open the App and verify the quote, permit, and simulation an agent prepared.
                </p>
              </article>
            </div>
          </section>

          <section>
            <SectionHeading label="Who it is for">Same recipes for agents and for people</SectionHeading>
            <div className="grid gap-3 md:grid-cols-2">
              <article className={darkCard}>
                <h3 className="text-xl font-medium tracking-[-0.02em]">For AI agents</h3>
                <p className="mt-3 text-sm leading-6 text-smoke">
                  Connect a remote MCP client with a short-lived, wallet-bound token. Tools can list
                  positions, quote, and prepare unsigned transactions plus a{" "}
                  <code className="rounded-md bg-white/10 px-1.5 py-0.5 font-data text-xs text-cream/90">signUrl</code>.
                  The laptop does not need RPC or Jupiter secrets.
                </p>
              </article>
              <article className={darkCard}>
                <h3 className="text-xl font-medium tracking-[-0.02em]">For humans</h3>
                <p className="mt-3 text-sm leading-6 text-smoke">
                  Open the App, connect Phantom or WalletConnect, and run the same compound or zap
                  path with a preview before you sign. Use the Use with AI page when you want an
                  agent to prepare and you to approve.
                </p>
              </article>
            </div>
          </section>

          <section id="how" className="scroll-mt-6">
            <SectionHeading label="How it works">Prepare, sign once, then broadcast</SectionHeading>
            <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                {
                  n: "01",
                  title: "Connect",
                  body: "Connect a Solana wallet. Agents also sign a short challenge to mint a wallet-bound MCP token.",
                },
                {
                  n: "02",
                  title: "Prepare a recipe",
                  body: "The engine quotes and builds an unsigned v0 transaction, simulates it, and binds an HMAC permit.",
                },
                {
                  n: "03",
                  title: "Sign once",
                  body: "Review the summary and approve in your wallet. Keys stay in the wallet; the server never holds them.",
                },
                {
                  n: "04",
                  title: "Re-simulate and send",
                  body: "Submit re-checks the permit and on-chain state, re-simulates, then broadcasts if the gates still pass.",
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

          <section id="scenarios" className="scroll-mt-6">
            <SectionHeading label="Automation scenarios">
              Strategies included today — and more on the way
            </SectionHeading>
            <p className="mb-6 max-w-2xl px-2 text-sm leading-6 text-smoke">
              Recipes shipping now sit on Raydium CLMM. Fee and return figures in the App are
              estimates from on-chain data, not a promise of future yield.
            </p>
            <div className="grid gap-3 lg:grid-cols-12">
              <Link
                href={APP_ROUTES.rwaPairs}
                className="group flex flex-col rounded-[28px] bg-lemon p-6 text-ink outline-none transition-transform hover:-translate-y-0.5 focus-visible:shadow-[0_0_0_3px_var(--color-cream)] sm:p-7 lg:col-span-5 lg:row-span-2"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="flex h-11 w-11 items-center justify-center rounded-full bg-ink text-lemon">
                    <Sprout className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span className={`${labelPill} border-ink/70`}>Live</span>
                </div>
                <h3 className="mt-10 text-[clamp(2rem,3.6vw,3rem)] font-medium leading-none tracking-[-0.04em]">
                  RWA Yield
                </h3>
                <p className="mt-4 border-t border-ink/25 pt-4 text-sm leading-6 text-ink/75">
                  Earn yield on same-asset RWA CLMM pools (wrapped vs unwrapped). Discover pairs,
                  review coin-denominated position performance, and compound fees back into the
                  position.
                </p>
                <p className="mt-auto flex items-center justify-between pt-8 text-sm font-semibold">
                  Open RWA pairs
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-ink text-lemon transition-transform group-hover:rotate-45">
                    <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                  </span>
                </p>
              </Link>

              <div className="grid gap-3 sm:grid-cols-2 lg:col-span-7 lg:row-span-2">
                {[
                  {
                    icon: CalendarClock,
                    title: "Dollar-cost averaging",
                    body: "Recurring deposits into a CLMM position from a chosen wallet asset.",
                  },
                  {
                    icon: Scale,
                    title: "Portfolio rebalancing",
                    body: "Shift liquidity across positions as allocations drift from a target mix.",
                  },
                  {
                    icon: MoveHorizontal,
                    title: "LP range management",
                    body: "Re-center concentrated ranges when price walks outside the current ticks.",
                  },
                  {
                    icon: Coins,
                    title: "Stablecoin yield rotation",
                    body: "Move liquidity between stable pools as fees and conditions change.",
                  },
                ].map((card) => (
                  <article key={card.title} className="rounded-[28px] border border-dashed border-white/20 p-6">
                    <div className="flex items-start justify-between gap-3">
                      <span className="flex h-11 w-11 items-center justify-center rounded-full border border-white/20 text-smoke">
                        <card.icon className="h-5 w-5" aria-hidden="true" />
                      </span>
                      <span className={`${labelPill} border-white/20 text-smoke`}>Coming soon</span>
                    </div>
                    <h3 className="mt-8 text-lg font-medium tracking-[-0.02em] text-cream/80">{card.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-smoke">{card.body}</p>
                  </article>
                ))}
              </div>
            </div>
          </section>

          <section className="mt-14 rounded-[28px] bg-cream p-8 text-ink sm:mt-20 sm:p-12">
            <h2 className="max-w-[18ch] text-[clamp(2rem,5vw,4rem)] font-medium leading-[1.02] tracking-[-0.04em]">
              Propose in the agent. Approve in the wallet.
            </h2>
            <div className="mt-8 flex flex-col gap-6 border-t border-ink/20 pt-6 md:flex-row md:items-center md:justify-between">
              <p className="max-w-xl text-sm leading-6 text-ink/70 sm:text-base">
                Launch the App to run a recipe yourself, or connect MCP so an agent can prepare the
                unsigned transaction you sign once.
              </p>
              <div className="flex flex-wrap gap-3">
                <ArrowCta href={APP_ROUTES.home} tone="ink">
                  Launch App
                </ArrowCta>
                <ArrowCta href={APP_ROUTES.ai} tone="outline-ink">
                  Use with AI
                </ArrowCta>
              </div>
            </div>
          </section>
        </main>

        <footer className="mt-6 flex flex-col gap-4 px-2 py-6 font-data text-[11px] uppercase tracking-[0.12em] text-smoke sm:flex-row sm:items-center sm:justify-between">
          <p>SoFinance · Non-custodial Solana LP toolkit · MIT</p>
          <div className="flex flex-wrap items-center gap-5">
            <Link href={APP_ROUTES.home} className="transition-colors hover:text-cream">
              App
            </Link>
            <Link href={APP_ROUTES.ai} className="transition-colors hover:text-cream">
              Use with AI
            </Link>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="transition-colors hover:text-cream">
              GitHub
            </a>
          </div>
        </footer>
      </div>
    </div>
  );
}

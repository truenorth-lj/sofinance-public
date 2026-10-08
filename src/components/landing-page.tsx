import Link from "next/link";
import Image from "next/image";
import {
  BookOpen,
  Wallet,
  Layers,
  Sprout,
  CalendarClock,
  Scale,
  MoveHorizontal,
  Coins,
  ArrowRight,
  Github,
} from "lucide-react";
import { APP_ROUTES } from "@/lib/public-urls";

const GITHUB_URL = "https://github.com/truenorth-lj/sofinance-public";

const primaryCta =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-neutral-100 px-5 py-3 text-sm font-semibold text-[#050505] transition-colors hover:bg-neutral-300";
const secondaryCta =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-neutral-700 bg-transparent px-5 py-3 text-sm font-semibold text-neutral-200 transition-colors hover:border-neutral-500 hover:bg-neutral-900/50";

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">{children}</p>
  );
}

export function LandingPage() {
  return (
    <div className="min-h-screen bg-[#050505] text-neutral-100">
      <header className="sticky top-0 z-20 border-b border-neutral-800/50 bg-[#050505]/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3.5 sm:px-8">
          <Link href="/" className="flex items-center gap-3 transition-opacity hover:opacity-70">
            <Image src="/logo.png" alt="SoFinance" width={36} height={36} className="rounded-lg" />
            <span className="text-sm font-bold tracking-wide">SoFinance</span>
          </Link>
          <Link href={APP_ROUTES.home} className={primaryCta}>
            Launch App
          </Link>
        </div>
      </header>

      <main>
        <section className="mx-auto max-w-6xl px-5 pb-16 pt-14 sm:px-8 sm:pb-24 sm:pt-20">
          <div className="mx-auto max-w-3xl text-center">
            <Image
              src="/logo.png"
              alt=""
              width={88}
              height={88}
              priority
              className="mx-auto rounded-2xl"
            />
            <h1 className="mt-8 text-3xl font-semibold tracking-tight text-neutral-50 sm:text-5xl sm:leading-[1.1]">
              Strategy recipes for AI agents and humans
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-base leading-7 text-neutral-400 sm:text-lg sm:leading-8">
              SoFinance turns multi-step Solana LP strategies into simulated, one-signature recipes
              — any AI agent can propose them, only your wallet can approve them.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link href={APP_ROUTES.home} className={`${primaryCta} w-full sm:w-auto`}>
                Launch App
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link href={APP_ROUTES.ai} className={`${secondaryCta} w-full sm:w-auto`}>
                Use with AI
              </Link>
            </div>
            <p className="mt-5">
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-neutral-500 underline-offset-4 transition-colors hover:text-neutral-300 hover:underline"
              >
                <Github className="h-3.5 w-3.5" />
                Source on GitHub
              </a>
            </p>
          </div>
        </section>

        <section className="border-t border-neutral-800/60">
          <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
            <SectionLabel>The problem</SectionLabel>
            <h2 className="mt-3 max-w-2xl text-2xl font-semibold tracking-tight sm:text-3xl">
              Multi-step LP work is easy to get wrong when you assemble it by hand
            </h2>
            <div className="mt-10 grid gap-4 md:grid-cols-2">
              <article className="rounded-[20px] border border-neutral-800/80 bg-[#0a0a0a] p-5 sm:p-7">
                <h3 className="text-base font-semibold text-neutral-100">Fragile, one-off transaction code</h3>
                <p className="mt-3 text-sm leading-6 text-neutral-400">
                  Agents and operators often rebuild Jupiter swaps, Raydium CLMM deposits, and
                  harvest-and-reinvest flows as ad-hoc scripts. Those paths skip a shared simulation
                  and the checks that belong with a real submit.
                </p>
              </article>
              <article className="rounded-[20px] border border-neutral-800/80 bg-[#0a0a0a] p-5 sm:p-7">
                <h3 className="text-base font-semibold text-neutral-100">Complex operations, many steps</h3>
                <p className="mt-3 text-sm leading-6 text-neutral-400">
                  A single compound or zap is several on-chain actions: quote, route, size to the
                  range, simulate, then sign. Rewriting that each time is how unsigned messages
                  drift and failed submits show up in the wallet.
                </p>
              </article>
            </div>
          </div>
        </section>

        <section className="border-t border-neutral-800/60">
          <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
            <SectionLabel>The toolkit</SectionLabel>
            <h2 className="mt-3 max-w-2xl text-2xl font-semibold tracking-tight sm:text-3xl">
              Three pillars
            </h2>
            <div className="mt-10 grid gap-4 lg:grid-cols-3">
              <article className="rounded-[20px] border border-neutral-800/80 bg-[#0a0a0a] p-5 sm:p-7">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-neutral-800 bg-neutral-900/70">
                  <BookOpen className="h-5 w-5 text-neutral-300" />
                </div>
                <h3 className="mt-5 text-base font-semibold text-neutral-100">Recipes, not primitives</h3>
                <p className="mt-3 text-sm leading-6 text-neutral-400">
                  Compound, zap, position performance, and RWA pair discovery are tested, simulated
                  multi-step flows. Agents call a recipe instead of hand-assembling swap plus
                  liquidity instructions.
                </p>
              </article>
              <article className="rounded-[20px] border border-neutral-800/80 bg-[#0a0a0a] p-5 sm:p-7">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-neutral-800 bg-neutral-900/70">
                  <Wallet className="h-5 w-5 text-neutral-300" />
                </div>
                <h3 className="mt-5 text-base font-semibold text-neutral-100">Agent proposes, wallet approves</h3>
                <p className="mt-3 text-sm leading-6 text-neutral-400">
                  The agent never holds a key. The server never takes custody. Each action is an
                  unsigned transaction you sign once in your wallet, then the server re-simulates
                  before sending.
                </p>
              </article>
              <article className="rounded-[20px] border border-neutral-800/80 bg-[#0a0a0a] p-5 sm:p-7">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-neutral-800 bg-neutral-900/70">
                  <Layers className="h-5 w-5 text-neutral-300" />
                </div>
                <h3 className="mt-5 text-base font-semibold text-neutral-100">One engine, two surfaces</h3>
                <p className="mt-3 text-sm leading-6 text-neutral-400">
                  The web UI and the MCP server share the same logic and safety gates, so a human
                  can open the App and verify the quote, permit, and simulation an agent prepared.
                </p>
              </article>
            </div>
          </div>
        </section>

        <section className="border-t border-neutral-800/60">
          <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
            <SectionLabel>Who it is for</SectionLabel>
            <h2 className="mt-3 max-w-2xl text-2xl font-semibold tracking-tight sm:text-3xl">
              Same recipes for agents and for people
            </h2>
            <div className="mt-10 grid gap-4 md:grid-cols-2">
              <article className="rounded-[20px] border border-neutral-800/80 bg-[#0a0a0a] p-5 sm:p-7">
                <h3 className="text-base font-semibold text-neutral-100">For AI agents</h3>
                <p className="mt-3 text-sm leading-6 text-neutral-400">
                  Connect a remote MCP client with a short-lived, wallet-bound token. Tools can list
                  positions, quote, and prepare unsigned transactions plus a{" "}
                  <code className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-300">signUrl</code>.
                  The laptop does not need RPC or Jupiter secrets.
                </p>
              </article>
              <article className="rounded-[20px] border border-neutral-800/80 bg-[#0a0a0a] p-5 sm:p-7">
                <h3 className="text-base font-semibold text-neutral-100">For humans</h3>
                <p className="mt-3 text-sm leading-6 text-neutral-400">
                  Open the App, connect Phantom or WalletConnect, and run the same compound or zap
                  path with a preview before you sign. Use the Use with AI page when you want an
                  agent to prepare and you to approve.
                </p>
              </article>
            </div>
          </div>
        </section>

        <section className="border-t border-neutral-800/60">
          <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
            <SectionLabel>How it works</SectionLabel>
            <h2 className="mt-3 max-w-2xl text-2xl font-semibold tracking-tight sm:text-3xl">
              Prepare, sign once, then broadcast
            </h2>
            <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
                <li
                  key={step.n}
                  className="rounded-[20px] border border-neutral-800/80 bg-[#0a0a0a] p-5 sm:p-6"
                >
                  <p className="text-xs font-semibold tracking-[0.16em] text-neutral-500">{step.n}</p>
                  <h3 className="mt-3 text-base font-semibold text-neutral-100">{step.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-neutral-400">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="border-t border-neutral-800/60" id="scenarios">
          <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
            <SectionLabel>Automation scenarios</SectionLabel>
            <h2 className="mt-3 max-w-2xl text-2xl font-semibold tracking-tight sm:text-3xl">
              Strategies included today — and more on the way
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-neutral-500">
              Recipes shipping now sit on Raydium CLMM. Fee and return figures in the App are
              estimates from on-chain data, not a promise of future yield.
            </p>
            <div className="mt-10 grid gap-4 sm:grid-cols-2">
              <Link
                href={APP_ROUTES.rwaPairs}
                className="group rounded-[20px] border border-neutral-700 bg-[#0a0a0a] p-5 transition-colors hover:border-neutral-500 hover:bg-neutral-900/40 sm:p-7"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-neutral-700 bg-neutral-900/70">
                    <Sprout className="h-5 w-5 text-neutral-200" />
                  </div>
                  <span className="rounded-full border border-neutral-600 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-300">
                    Live
                  </span>
                </div>
                <h3 className="mt-5 text-lg font-semibold text-neutral-50">RWA Yield</h3>
                <p className="mt-3 text-sm leading-6 text-neutral-400">
                  Earn yield on same-asset RWA CLMM pools (wrapped vs unwrapped). Discover pairs,
                  review coin-denominated position performance, and compound fees back into the
                  position.
                </p>
                <p className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-neutral-200">
                  Open RWA pairs
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </p>
              </Link>

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
                <article
                  key={card.title}
                  aria-disabled="true"
                  className="rounded-[20px] border border-neutral-800/70 bg-[#0a0a0a] p-5 opacity-50 sm:p-7"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-neutral-800 bg-neutral-900/70">
                      <card.icon className="h-5 w-5 text-neutral-400" />
                    </div>
                    <span className="rounded-full border border-neutral-700 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                      Coming soon
                    </span>
                  </div>
                  <h3 className="mt-5 text-lg font-semibold text-neutral-300">{card.title}</h3>
                  <p className="mt-3 text-sm leading-6 text-neutral-500">{card.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-neutral-800/60">
          <div className="mx-auto max-w-3xl px-5 py-16 text-center sm:px-8 sm:py-24">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Propose in the agent. Approve in the wallet.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-sm leading-6 text-neutral-400 sm:text-base">
              Launch the App to run a recipe yourself, or connect MCP so an agent can prepare the
              unsigned transaction you sign once.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link href={APP_ROUTES.home} className={`${primaryCta} w-full sm:w-auto`}>
                Launch App
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link href={APP_ROUTES.ai} className={`${secondaryCta} w-full sm:w-auto`}>
                Use with AI
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-neutral-800/60">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-5 py-8 text-xs text-neutral-500 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <p>SoFinance · Non-custodial Solana LP toolkit · MIT</p>
          <div className="flex flex-wrap items-center gap-4">
            <Link href={APP_ROUTES.home} className="hover:text-neutral-300">
              App
            </Link>
            <Link href={APP_ROUTES.ai} className="hover:text-neutral-300">
              Use with AI
            </Link>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="hover:text-neutral-300">
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

import Link from "next/link";
import { PositionPerformancePanel } from "@/components/position-performance-panel";

export const metadata = {
  title: "Position performance · SoFinance",
  description: "Holding-period return and realized fee APR for a Raydium CLMM position NFT from on-chain facts.",
};

export default function PositionPerformancePage() {
  return (
    <div className="min-h-screen bg-[#07101d] text-slate-100">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(ellipse_at_top,rgba(40,91,153,0.22),transparent_60%)]" />
      <div className="relative mx-auto max-w-3xl px-5 pb-24 pt-6 sm:px-8 sm:pt-10">
        <header className="flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-sky-400/40 bg-sky-400/10 text-lg font-bold text-sky-300">S</div>
            <div>
              <div className="text-sm font-bold tracking-wide">SoFinance</div>
              <div className="text-xs text-slate-400">Position performance</div>
            </div>
          </Link>
          <div className="flex gap-2">
            <Link href="/rwa-pairs" className="rounded-xl border border-slate-600 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-100 hover:bg-slate-700">
              RWA pairs
            </Link>
            <Link href="/" className="rounded-xl border border-slate-600 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-100 hover:bg-slate-700">
              Positions
            </Link>
          </div>
        </header>

        <div className="mb-6 mt-8 sm:mt-10">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Position performance</h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-400">
            Prove holding-period return and realized fee APR from Raydium CLMM on-chain events
            (open / increase / decrease) plus current equity — not the pool&apos;s 24h feeApr.
            Same-asset RWA wrap pairs prefer token-equivalent (TE) in the plain/base ticker via
            current tick mid; raw A/B inventory always shown. USD is secondary. Read-only; no database.
          </p>
        </div>

        <PositionPerformancePanel />
      </div>
    </div>
  );
}

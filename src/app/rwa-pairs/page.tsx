import Link from "next/link";
import { RwaPairsPanel } from "@/components/rwa-pairs-panel";

export const metadata = {
  title: "RWA pairs · SoFinance",
  description: "Discover Raydium CLMM same-asset RWA trading pairs filtered by Jupiter tags and xStocks whitelist.",
};

export default function RwaPairsPage() {
  return (
    <div className="min-h-screen bg-[#07101d] text-slate-100">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(ellipse_at_top,rgba(40,91,153,0.22),transparent_60%)]" />
      <div className="relative mx-auto max-w-5xl px-5 pb-24 pt-6 sm:px-8 sm:pt-10">
        <header className="flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-sky-400/40 bg-sky-400/10 text-lg font-bold text-sky-300">S</div>
            <div>
              <div className="text-sm font-bold tracking-wide">SoFinance</div>
              <div className="text-xs text-slate-400">RWA pair discovery</div>
            </div>
          </Link>
          <Link href="/" className="rounded-xl border border-slate-600 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-100 hover:bg-slate-700">
            Back to positions
          </Link>
        </header>

        <div className="mb-6 mt-8 sm:mt-10">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Same-asset RWA pairs</h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-400">
            Find Raydium CLMM pools where both tokens represent the same underlying (wrapped vs unwrapped /
            Jupiter stocks/rwa tags + xStocks whitelist). Ranked by estimated fee APR from 24h fees and TVL. Read-only — no auto-open position.
          </p>
        </div>

        <RwaPairsPanel />
      </div>
    </div>
  );
}

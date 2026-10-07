import Link from "next/link";
import { Geist } from "next/font/google";
import { RwaPairsPanel } from "@/components/rwa-pairs-panel";

const geist = Geist({ subsets: ["latin"] });

export const metadata = {
  title: "RWA pairs · SoFinance",
  description: "Discover Raydium CLMM same-asset RWA trading pairs filtered by Jupiter tags and xStocks whitelist.",
};

export default function RwaPairsPage() {
  return (
    <div className={`min-h-screen bg-[#050505] text-neutral-100 ${geist.className}`}>
      <div className="relative mx-auto max-w-5xl px-5 pb-24 pt-6 sm:px-8 sm:pt-10">
        <header className="flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-3 transition-opacity hover:opacity-70">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-neutral-800 bg-neutral-900 text-lg font-bold text-neutral-100">S</div>
            <div>
              <div className="text-sm font-bold tracking-wide text-neutral-100">SoFinance</div>
              <div className="text-xs text-neutral-500">RWA pair discovery</div>
            </div>
          </Link>
          <div className="flex gap-2">
            <Link href="/position-performance" className="rounded-xl border border-neutral-800 bg-transparent px-3 py-2 text-xs font-semibold text-neutral-300 transition-colors hover:border-neutral-700 hover:bg-neutral-900/50">
              Position performance
            </Link>
            <Link href="/" className="rounded-xl border border-neutral-800 bg-transparent px-3 py-2 text-xs font-semibold text-neutral-300 transition-colors hover:border-neutral-700 hover:bg-neutral-900/50">
              Back to positions
            </Link>
          </div>
        </header>

        <div className="mb-8 mt-10 sm:mt-12">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-100 sm:text-3xl">Same-asset RWA pairs</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-neutral-500">
            Find Raydium CLMM pools where both tokens represent the same underlying (wrapped vs unwrapped /
            Jupiter stocks/rwa tags + xStocks whitelist). Ranked by estimated fee APR from 24h fees and TVL. Read-only — no auto-open position.
          </p>
        </div>

        <RwaPairsPanel />
      </div>
    </div>
  );
}

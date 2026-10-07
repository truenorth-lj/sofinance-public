import { InkShell, InkHeader } from "@/components/ink";
import { RwaPairsPanel } from "@/components/rwa-pairs-panel";

export const metadata = {
  title: "RWA pairs · SoFinance",
  description: "Discover Raydium CLMM same-asset RWA trading pairs filtered by Jupiter tags and xStocks whitelist.",
};

export default function RwaPairsPage() {
  return (
    <InkShell>
      <InkHeader
        subtitle="RWA pair discovery"
        navLinks={[
          { href: "/position-performance", label: "Position performance" },
          { href: "/", label: "Back to positions" },
        ]}
      />

      <div className="mb-8 mt-10 sm:mt-12">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-100 sm:text-3xl">Same-asset RWA pairs</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-neutral-500">
          Find Raydium CLMM pools where both tokens represent the same underlying (wrapped vs unwrapped /
          Jupiter stocks/rwa tags + xStocks whitelist). Ranked by estimated fee APR from 24h fees and TVL. Read-only — no auto-open position.
        </p>
      </div>

      <RwaPairsPanel />
    </InkShell>
  );
}

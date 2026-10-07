"use client";

import { InkShell, InkNav } from "@/components/ink";
import { RwaPairsPanel } from "@/components/rwa-pairs-panel";

export default function RwaPairsPage() {
  return (
    <InkShell>
      <InkNav
        subtitle="Solana · Raydium CLMM"
        navLinks={[
          { href: "/", label: "Positions" },
          { href: "/position-performance", label: "Position performance" },
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

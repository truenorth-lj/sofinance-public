import { InkShell, InkHeader } from "@/components/ink";
import { PositionPerformancePanel } from "@/components/position-performance-panel";

export const metadata = {
  title: "Position performance · SoFinance",
  description: "Holding-period return and realized fee APR for a Raydium CLMM position NFT from on-chain facts.",
};

export default function PositionPerformancePage() {
  return (
    <InkShell maxWidth="3xl">
      <InkHeader
        subtitle="Position performance"
        navLinks={[
          { href: "/rwa-pairs", label: "RWA pairs" },
          { href: "/", label: "Positions" },
        ]}
      />

      <div className="mb-6 mt-8 sm:mt-10">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-100 sm:text-3xl">Position performance</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-neutral-500">
          Prove holding-period return and realized fee APR from Raydium CLMM on-chain events
          (open / increase / decrease) plus current equity — not the pool&apos;s 24h feeApr.
          Same-asset RWA wrap pairs prefer token-equivalent (TE) in the plain/base ticker via
          current tick mid; raw A/B inventory always shown. USD is secondary. Read-only; no database.
        </p>
      </div>

      <PositionPerformancePanel />
    </InkShell>
  );
}

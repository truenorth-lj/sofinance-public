"use client";

import { Suspense } from "react";
import { InkHero, InkShell, InkNav } from "@/components/ink";
import {
  PositionPerformancePanelFallback,
  PositionPerformanceQueryPanel,
} from "@/components/position-performance-query-panel";
import { useWalletConnection } from "@/components/wallet-connection";

export default function PositionPerformancePage() {
  const { address, connected, connect, disconnect } = useWalletConnection();

  return (
    <InkShell>
      <InkNav wallet={address} connected={connected} onConnect={connect} onDisconnect={disconnect} />

      <div className="mt-3 grid gap-3 lg:grid-cols-12">
      <InkHero stacked className="mt-0 lg:col-span-7" label="Performance" title="Position performance">
        <p>
          Prove holding-period return and realized fee APR from Raydium CLMM on-chain events
          (open / increase / decrease) plus current equity — not the pool&apos;s 24h feeApr.
          Same-asset RWA wrap pairs prefer token-equivalent (TE) in the plain/base ticker via
          current tick mid; raw A/B inventory always shown. USD is secondary. The daily chart is
          estimated pool fee APR (Raydium TVL history × GeckoTerminal volume), plus sparse
          on-chain realized fee APR points — not interpolated. Read-only; no database.
        </p>
      </InkHero>

      <Suspense fallback={<PositionPerformancePanelFallback />}>
        <PositionPerformanceQueryPanel />
      </Suspense>
      </div>
    </InkShell>
  );
}

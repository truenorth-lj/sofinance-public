"use client";

import { Suspense } from "react";
import { InkShell, InkNav } from "@/components/ink";
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

      <div className="mb-6 mt-8 sm:mt-10">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-100 sm:text-3xl">Position performance</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-neutral-500">
          Prove holding-period return and realized fee APR from Raydium CLMM on-chain events
          (open / increase / decrease) plus current equity — not the pool&apos;s 24h feeApr.
          Same-asset RWA wrap pairs prefer token-equivalent (TE) in the plain/base ticker via
          current tick mid; raw A/B inventory always shown. USD is secondary. Read-only; no database.
        </p>
      </div>

      <Suspense fallback={<PositionPerformancePanelFallback />}>
        <PositionPerformanceQueryPanel />
      </Suspense>
    </InkShell>
  );
}

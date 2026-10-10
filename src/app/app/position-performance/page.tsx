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
          Select a position, then compute its holding-period return and trading fees.
          No position yet? Explore RWA Pairs to get started.
        </p>
      </InkHero>

      <Suspense fallback={<PositionPerformancePanelFallback />}>
        <PositionPerformanceQueryPanel />
      </Suspense>
      </div>
    </InkShell>
  );
}

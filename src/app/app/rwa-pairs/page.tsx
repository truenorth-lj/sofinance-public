"use client";

import { Suspense } from "react";
import { InkShell, InkNav } from "@/components/ink";
import { RwaPairsPanel } from "@/components/rwa-pairs-panel";
import { useWalletConnection } from "@/components/wallet-connection";

export default function RwaPairsPage() {
  const { address, connected, connect, disconnect } = useWalletConnection();

  return (
    <InkShell>
      <InkNav wallet={address} connected={connected} onConnect={connect} onDisconnect={disconnect} />

      <div className="mb-8 mt-10 sm:mt-12">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-100 sm:text-3xl">Same-asset RWA pairs</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-neutral-500">
          Find Raydium CLMM pools where both tokens represent the same underlying (wrapped vs unwrapped /
          Jupiter stocks/rwa tags + xStocks whitelist). Ranked by estimated fee APR from 24h fees and TVL.
          Daily APR sparklines are estimated (volume × feeRate ÷ TVL), not Raydium daily feeApr.
          Add liquidity opens a new concentrated position without leaving SoFinance.
        </p>
      </div>

      <Suspense fallback={<p className="text-sm text-neutral-500">Loading pairs…</p>}>
        <RwaPairsPanel />
      </Suspense>
    </InkShell>
  );
}

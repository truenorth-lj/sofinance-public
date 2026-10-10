"use client";

import { Suspense } from "react";
import { InkHero, InkShell, InkNav } from "@/components/ink";
import { RwaPairsPanel } from "@/components/rwa-pairs-panel";
import { useWalletConnection } from "@/components/wallet-connection";

export default function RwaPairsPage() {
  const { address, connected, connect, disconnect } = useWalletConnection();

  return (
    <InkShell>
      <InkNav wallet={address} connected={connected} onConnect={connect} onDisconnect={disconnect} />

      <InkHero label="RWA pairs" title="Same-asset RWA pairs">
        <p>
          Find Raydium CLMM pools where both tokens represent the same underlying (wrapped vs unwrapped /
          Jupiter stocks/rwa tags + xStocks whitelist). Ranked by estimated fee APR from 24h fees and TVL.
          Daily APR sparklines are estimated (volume × feeRate ÷ TVL), not Raydium daily feeApr.
          Add liquidity opens a new concentrated position without leaving SoFinance.
        </p>
      </InkHero>

      <Suspense fallback={<p className="mt-6 px-2 text-sm text-smoke">Loading pairs…</p>}>
        <RwaPairsPanel />
      </Suspense>
    </InkShell>
  );
}

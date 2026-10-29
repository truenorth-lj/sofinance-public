import { notFound } from "next/navigation";
import { InkHero, InkShell } from "@/components/ink";
import { MeteoraOpenPanel } from "@/components/meteora-open-panel";
import { loadMeteoraOpenPoolView } from "@/lib/meteora-open-view";
import { isMeteoraDlmmTxBuildEnabled, isMeteoraDlmmWalletSigningEnabled } from "@/lib/protocol-flags";

/** Meteora DLMM open flow (design PR12). `METEORA_DLMM_TX_BUILD_ENABLED` off (production) → 404. */
export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

export default async function MeteoraPage() {
  if (!isMeteoraDlmmTxBuildEnabled()) notFound();
  const view = await loadMeteoraOpenPoolView();
  return (
    <InkShell>
      <InkHero label="Meteora DLMM" title="cbBTC / WBTC positions">
        <p>
          Two transactions. 1/2 only creates your own accounts (the position account and any missing token accounts); you pay
          the rent and get the position rent back when you close it. 2/2 swaps the part you need through Jupiter (10 bps
          SoFinance fee on the swapped portion only) and adds liquidity. Every step is simulated first.
        </p>
      </InkHero>
      <MeteoraOpenPanel view={view} signingEnabled={isMeteoraDlmmWalletSigningEnabled()} />
    </InkShell>
  );
}

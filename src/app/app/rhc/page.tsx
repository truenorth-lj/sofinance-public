import { notFound } from "next/navigation";
import { InkHero, InkShell } from "@/components/ink";
import { RhcUniv4OpenPanel } from "@/components/rhc-univ4-open-panel";
import { isRhcUniv4TradingEnabled, isRhcUniv4WalletSigningEnabled } from "@/lib/protocol-flags";
import { loadRhcPoolView } from "@/lib/rhc-univ4-pool-view";

/** Robinhood Chain Uniswap v4 open flow (design §6 PR5). `RHC_UNIV4_TRADING_ENABLED` off (production) → 404. */
export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

export default async function RhcPage() {
  if (!isRhcUniv4TradingEnabled()) notFound();
  const pool = await loadRhcPoolView();
  return (
    <InkShell>
      <InkHero label="Robinhood Chain" title="Open a SPCX / SPCXon position">
        <p>
          One Uniswap v4 transaction on Robinhood Chain: swap the part you need, open the position and return any leftover.
          Preview build: every step is simulated before your wallet is asked to sign.
        </p>
      </InkHero>
      <RhcUniv4OpenPanel pool={pool} signingEnabled={isRhcUniv4WalletSigningEnabled()} />
    </InkShell>
  );
}

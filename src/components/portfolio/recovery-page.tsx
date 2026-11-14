"use client";

import Link from "next/link";
import { HarvestAccountManagement } from "../compound-panel";
import { InkFooter, InkNav, InkShell } from "../ink";
import { useCompoundController } from "../use-compound-controller";
import { useTokenMetadata } from "../use-token-metadata";
import { useWalletConnection } from "../wallet-connection";
import { shortAddress } from "@/lib/format/address";
import { APP_ROUTES } from "@/lib/public-urls";
import { parsePositionKey } from "@/lib/unified-positions/model";
import { raydiumPositionSource } from "@/lib/unified-positions/sources/raydium";

/**
 * `/app/portfolio/recovery`: harvest account management on its own page (LJ 11/14), off the Portfolio main screen and
 * linked only from a Raydium position's details. Same controller and flows as before (scan, clean up all, retrieve one
 * balance, recover records); `?position=` lists that position's records first.
 */
export function RecoveryPage({ positionKey = "" }: { positionKey?: string }) {
  const { address, connected, connect, disconnect } = useWalletConnection();
  const linked = parsePositionKey(positionKey);
  const positionMint = linked?.source === raydiumPositionSource.id ? linked.nativeId : undefined;
  const compound = useCompoundController({ wallet: connected ? address || undefined : undefined, positionMint, externalBlocked: false, onConfirmed: () => {} });
  const metadata = useTokenMetadata(compound.receipts.flatMap((receipt) => receipt.compoundAccounts.map((account) => account.mint)));
  const tokenLabel = (mint: string) => metadata[mint]?.symbol || shortAddress(mint);
  const back = positionKey ? `${APP_ROUTES.home}?position=${encodeURIComponent(positionKey)}` : APP_ROUTES.home;
  return <InkShell>
    <InkNav wallet={address} connected={connected} onConnect={connect} onDisconnect={disconnect} />
    <section aria-labelledby="recovery-heading" data-testid="harvest-recovery-page" className="mt-5 rounded-[28px] border border-white/12 bg-char p-5 text-xs text-smoke sm:p-7">
      <Link href={back} className="text-xs font-semibold text-cream/80 underline underline-offset-2 hover:opacity-70">← Back to Portfolio</Link>
      <h1 id="recovery-heading" className="mt-3 text-xl font-semibold text-cream">Recover leftover compound balances</h1>
      <p className="mt-2 max-w-2xl text-xs leading-5">Older compounds could leave small balances in harvest accounts your wallet controls. Find them here, move them back into your wallet and get the account rent back.</p>
      {positionMint && <p className="mt-2 text-xs">Position {shortAddress(positionMint)} records are listed first.</p>}
      {!connected ? <div className="mt-5 flex flex-wrap items-center gap-3">
        <p className="text-sm text-cream/80">Connect your wallet to look for leftover balances.</p>
        <button type="button" onClick={connect} className="rounded-full bg-lemon px-4 py-2 text-sm font-semibold text-ink transition-colors hover:bg-[#fff27f]">Connect wallet</button>
      </div> : <HarvestAccountManagement controller={compound} tokenLabel={tokenLabel} standalone />}
    </section>
    <InkFooter />
  </InkShell>;
}

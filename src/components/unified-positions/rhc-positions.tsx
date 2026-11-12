"use client";

import type { PositionLookup } from "@sofinance/engine/protocols/uniswap-v4/exit-flow";
import { useEffect, useMemo, useState } from "react";
import { trackedPositionIds, trackPositionId, untrackPositionId } from "@/lib/rhc-wallet/exit-execute";
import { APP_ROUTES } from "@/lib/public-urls";
import { rhcPositionSource, type RhcNative } from "@/lib/unified-positions/sources/rhc";
import type { ToolId, UnifiedPosition } from "@/lib/unified-positions/model";
import { useOptionalEvmWalletConnection } from "../evm-wallet-connection";
import type { RhcWallet } from "../rhc-univ4-open-panel";
import { poolOf, useRhcClose } from "../rhc-close";
import { CloseStatus, RhcCloseFollowup } from "../rhc-univ4-positions-panel";
import { RhcPositionsToolbar } from "../rhc-positions-toolbar";
import { useRhcPositionList } from "../use-rhc-position-list";
import { RhcWrongNetworkPrompt } from "../unified-pools/rhc-wrong-network-prompt";
import { PositionAssetRow } from "../position-asset-row";
import type { ExternalPositions } from "./external-positions";
import { fetchPositionValues, type RhcPositionValueRow } from "./rhc-values";
import { shortAddress } from "@/lib/format/address";

const short = shortAddress;
const nativeOf = (position: UnifiedPosition) => position.native as RhcNative;

/**
 * Robinhood Chain Uniswap v4 positions for `/app` My positions: the wallet's on-chain holdings (server scan) plus NFT ids opened
 * in this browser or added by hand, and the existing full Close flow as the Withdraw tool. Same reads, guards and copy as the
 * pools-page `RhcUniv4PositionsPanel`. Nothing loads until the nav's EVM wallet is connected and on Robinhood Chain.
 */
export function useRhcPositions({ wallet, signingEnabled, refreshKey, receiptPoll }: {
  wallet: RhcWallet | null; signingEnabled: boolean; refreshKey: number; receiptPoll?: { intervalMs?: number; timeoutMs?: number };
}): ExternalPositions | undefined {
  const wrongNetwork = useOptionalEvmWalletConnection()?.wrongNetwork ?? false;
  const address = wallet && !wrongNetwork ? wallet.address : null;
  const list = useRhcPositionList({ address, refreshKey, trackedIds: trackedPositionIds });
  const close = useRhcClose({ wallet, receiptPoll, onClosed: async () => { await list.load(); } });

  const { lookups, scan, loadError, loading, addId, setAddId } = list;
  const positions = useMemo(() => rhcPositionSource.fromDiscovery({ scanned: scan?.positions ?? [], lookups }), [scan, lookups]);
  // Liquidity amounts + unclaimed fees for the detail panel (same rows as Solana); a dash while loading or when unread.
  const valueIds = positions.filter((p) => { const view = nativeOf(p).lookup.position; return view ? poolOf(view) !== null : false; }).map((p) => p.nativeId).sort().join(",");
  const [values, setValues] = useState<{ ids: string; rows: Map<string, RhcPositionValueRow> } | null>(null);
  useEffect(() => {
    if (!valueIds) return;
    let live = true;
    void fetchPositionValues(valueIds.split(",")).then((rows) => { if (live) setValues({ ids: valueIds, rows }); });
    return () => { live = false; };
  }, [valueIds, refreshKey]);
  const valueOf = (tokenId: string) => values?.rows.get(tokenId) ?? null;
  if (!wallet) return undefined;

  const add = () => list.submitAdd(trackPositionId);
  const remove = (id: string) => { list.submitRemove(id, untrackPositionId); if (close.ready?.position.tokenId === id) close.setReady(null); };
  const scanning = list.scanning;
  const sentElsewhere = close.sent && !positions.some((p) => p.nativeId === close.sent!.tokenId) ? close.sent : null;

  const status = <div className="mt-4 border-t border-white/10 pt-4" data-testid="rhc-positions-section">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm font-semibold text-cream">Robinhood Chain</p>
      <p className="text-xs text-smoke" data-testid="rhc-wallet">{wallet.name}: {short(wallet.address)}</p>
    </div>
    {wrongNetwork ? <RhcWrongNetworkPrompt purpose="see and manage your positions" /> : <>
      <RhcPositionsToolbar
        intro={<p className="mt-1 text-xs text-smoke">Uniswap v4 positions this wallet holds on Robinhood Chain show up automatically. Missing one? Add its position NFT number.</p>}
        addId={addId} onAddId={setAddId} onAdd={add} loading={loading} scanning={scanning}
        scanError={scan?.error} loadError={loadError}
        empty={!loading && !scanning && !positions.length && !loadError && !scan?.error
          ? <p className="mt-2 text-xs text-smoke" data-testid="positions-empty">
            No Robinhood Chain positions in this wallet. <a href={APP_ROUTES.rwaPairs} className="font-semibold text-cream underline underline-offset-4">Open a new position</a></p> : null} />
      {sentElsewhere ? <CloseStatus sent={sentElsewhere} symbols={["SPCX", "SPCXon"]} /> : null}
    </>}
  </div>;

  return {
    chain: "robinhood-chain",
    sourceIds: [rhcPositionSource.id],
    source: rhcPositionSource as never,
    positions: wrongNetwork ? [] : positions,
    status,
    emptyOption: wrongNetwork ? "Switch to Robinhood Chain to see positions" : scanning ? "Checking Robinhood Chain…" : "No positions found",
    busy: close.busy !== null,
    header: (position) => {
      const { lookup, held, priceRange } = nativeOf(position);
      const p = lookup.position;
      return <div className="mt-3 space-y-2 text-xs" data-testid="rhc-position-header">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-white/20 bg-white/[0.05] px-2.5 py-1 text-cream/80" data-testid="rhc-range">
            {priceRange ? `Range ${priceRange.text}` : p ? `Ticks ${p.tickLower} to ${p.tickUpper}` : "Range unknown"}</span>
          {held ? <span className="rounded-full border border-white/15 px-1.5 py-0.5 text-[10px] text-smoke" data-testid="position-in-wallet">In your wallet</span> : null}
          {!held && (!p || !p.ownedByUser) ? <button type="button" onClick={() => remove(lookup.tokenId)} className="text-xs text-smoke underline">Remove</button> : null}
        </div>
        {p && p.ownedByUser && p.liquidity === "0" ? <p className="text-smoke">No liquidity left; closing burns the NFT and collects any remaining fees.</p> : null}
        <RhcAssetRows position={p} value={valueOf(lookup.tokenId)} />
      </div>;
    },
    details: (position) => {
      const { lookup, priceRange } = nativeOf(position);
      const p = lookup.position;
      return <>
        <p>Position NFT: #{lookup.tokenId}</p>
        {p ? <p data-testid="rhc-ticks">Ticks {p.tickLower} to {p.tickUpper}{priceRange ? ` (price ${priceRange.text})` : ""} · liquidity {p.liquidity}</p> : null}
        {p?.poolId ? <p>Pool: {p.poolId}</p> : null}
        {p ? <p>Owner: {p.owner}</p> : null}
      </>;
    },
    tool: (position, tool: ToolId) => {
      if (tool !== "withdraw") return null;
      const { lookup } = nativeOf(position);
      const p = lookup.position;
      const pool = p ? poolOf(p) : null;
      const symbols: [string, string] = pool ? [pool.currency0.symbol, pool.currency1.symbol] : ["token0", "token1"];
      const { busy, ready, error, sent, preview, confirm } = close;
      return <section className="mt-3 rounded-[28px] border border-white/12 bg-char p-5 sm:p-8" data-testid="rhc-withdraw" data-position={lookup.tokenId}>
        <h2 className="text-lg font-semibold text-cream">Withdraw · full close</h2>
        <p className="mt-2 text-xs leading-5 text-smoke">Closing removes all liquidity, collects accrued pool fees and burns the position NFT. Partial withdraw is not available on Robinhood Chain yet.</p>
        <button type="button" disabled={busy !== null} onClick={() => preview(lookup.tokenId)}
          className="mt-4 rounded-lg border border-white/25 px-3 py-1.5 text-xs font-semibold text-cream disabled:opacity-40">{busy === lookup.tokenId && !ready ? "Simulating…" : "Close"}</button>
        <RhcCloseFollowup tokenId={lookup.tokenId} signingEnabled={signingEnabled} ready={ready} busy={busy} error={error} sent={sent} confirm={confirm} symbols={symbols} />
      </section>;
    },
  };
}

/**
 * The shared detail-panel token rows (Liquidity + Unclaimed fees, USD when an indexer prices the token), same component and
 * format as Solana. A field that could not be read shows a dash; a position outside the allowlist has no known tokens.
 */
function RhcAssetRows({ position, value }: { position: PositionLookup["position"]; value: RhcPositionValueRow | null }) {
  const pool = position ? poolOf(position) : null;
  const tokens = pool ? [pool.currency0, pool.currency1] as const : null;
  return <div aria-label="Position assets" className="!mt-5 divide-y divide-white/10" data-testid="rhc-position-assets">
    {[0, 1].map((i) => {
      const token = tokens?.[i];
      return <PositionAssetRow key={i} symbol={token?.symbol ?? `Token ${i}`} icon={null} decimals={token?.decimals ?? 18}
        liquidityRaw={token ? (i === 0 ? value?.amount0 : value?.amount1) ?? null : null}
        unclaimedFeesRaw={token ? (i === 0 ? value?.fees0 : value?.fees1) ?? null : null}
        priceUsd={token ? (i === 0 ? value?.priceUsd0 : value?.priceUsd1) ?? null : null} />;
    })}
  </div>;
}

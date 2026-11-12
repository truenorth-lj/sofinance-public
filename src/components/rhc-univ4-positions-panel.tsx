"use client";

import type { PositionLookup, RhcPositionView } from "@sofinance/engine/protocols/uniswap-v4/exit-flow";
import type { ScannedPosition } from "@sofinance/engine/protocols/uniswap-v4/position-scan";
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { trackedPositionIds, trackPositionId, untrackPositionId } from "@/lib/rhc-wallet/exit-execute";
import { explorerTxUrl } from "@/lib/rhc-wallet/open-execute";
import { rhcPairLabel } from "@/lib/unified-pools/rows";
import {
  fetchPositions, fetchScan, poolOf, useRhcClose, type RhcCloseReady, type RhcCloseSent, type RhcWalletRef, type Scan,
} from "./rhc-close";
import { shortAddress } from "@/lib/format/address";

/**
 * Robinhood Chain (4663) Uniswap v4 positions + Close (PR7), inside the `/app/rhc` panel (same flags: page behind
 * `RHC_UNIV4_TRADING_ENABLED`, server build behind `RHC_UNIV4_TX_BUILD_ENABLED`, wallet send behind
 * `RHC_UNIV4_WALLET_SIGNING_ENABLED`). Positions come from the wallet's on-chain holdings (server scan of the
 * PositionManager's Transfer logs, `GET /api/rhc-univ4-positions`), plus, deduped, NFT ids opened in this browser or
 * added by hand (still shown when the scan fails). Close = server prepare (owner + allowlist checks, simulation from the owner) →
 * client guards (4663, pinned PositionManager, sender, value 0, re-decoded actions) → one `eth_sendTransaction` →
 * receipt → refresh positions and balances. No fee on exit.
 */

type Wallet = RhcWalletRef;
type Ready = RhcCloseReady;
type CloseSent = RhcCloseSent;

const fmt = (raw: string | bigint, decimals = 18, digits = 6) => {
  const [i, f = ""] = formatUnits(BigInt(raw), decimals).split(".");
  const frac = f.slice(0, digits).replace(/0+$/, "");
  return frac ? `${i}.${frac}` : i!;
};
const short = shortAddress;

export function ClosePreview({ ready }: { ready: Ready }) {
  const pool = poolOf(ready.position)!;
  return <div className="mt-2 space-y-1 rounded-lg border border-white/12 p-2 text-xs text-cream/90" data-testid="close-preview">
    <p>You receive ≈ {fmt(ready.expected.amount0, pool.currency0.decimals)} {pool.currency0.symbol} + {fmt(ready.expected.amount1, pool.currency1.decimals)} {pool.currency1.symbol} (includes accrued pool fees)</p>
    <p className="text-cream/70">At least {fmt(ready.min.amount0, pool.currency0.decimals)} {pool.currency0.symbol} + {fmt(ready.min.amount1, pool.currency1.decimals)} {pool.currency1.symbol} ({ready.slippageBps / 100}% price protection). No SoFinance fee on closing.</p>
    <p className="text-cream/70">Network fee at most ≈ {Number(formatUnits(BigInt(ready.gas.maxCostWei), 18)).toPrecision(2)} ETH. Simulated at block {ready.blockNumber}; the position NFT is burned.</p>
  </div>;
}

export function CloseStatus({ sent, symbols }: { sent: CloseSent; symbols: [string, string] }) {
  const link = <a href={explorerTxUrl(sent.hash)} target="_blank" rel="noopener noreferrer" className="underline">{sent.hash.slice(0, 10)}…{sent.hash.slice(-6)}</a>;
  const text = {
    pending: <>Closing… waiting for Robinhood Chain to confirm: {link}</>,
    success: <>Closed. ≈{fmt(sent.expected.amount0)} {symbols[0]} + {fmt(sent.expected.amount1)} {symbols[1]} returned to your wallet: {link}</>,
    reverted: <>The close transaction failed on chain, so your position is still open: {link}. Preview again to retry.</>,
    timeout: <>Not confirmed after 2 minutes. Check the explorer before trying again; do not resend: {link}</>,
  }[sent.status];
  return <p role="status" aria-busy={sent.status === "pending"} className="mt-2 text-xs text-cream/90" data-testid={`close-${sent.status}`}>
    {sent.status === "pending" ? <span className="mr-1 inline-block h-3 w-3 animate-spin rounded-full border border-white/40 border-t-transparent align-middle" aria-hidden /> : null}
    {text}
  </p>;
}

/** A held position outside SoFinance's allowlist: labelled, view only. */
const otherPoolNote = (s: ScannedPosition | undefined) => s?.stablePair
  ? "StablePair pool that SoFinance does not list yet: view only."
  : "Another Uniswap v4 pool, not supported by SoFinance: view only.";

export function RhcUniv4PositionsPanel({ wallet, signingEnabled, refreshKey = 0, onChanged, receiptPoll }: {
  wallet: Wallet | null; signingEnabled: boolean; refreshKey?: number; onChanged?: () => void; receiptPoll?: { intervalMs?: number; timeoutMs?: number };
}) {
  const [lookups, setLookups] = useState<PositionLookup[]>([]);
  const [scan, setScan] = useState<Scan | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [addId, setAddId] = useState("");
  const address = wallet?.address ?? null;

  /** User-triggered refresh (add / remove / after a close). */
  const load = async (ids?: string[]) => {
    if (!address) return;
    setLoading(true);
    const [r, s] = await Promise.all([fetchPositions(address, ids ?? trackedPositionIds(address)), ids ? Promise.resolve(null) : fetchScan(address, true)]);
    setLookups(r.lookups); setLoadError(r.error); if (s) setScan(s); setLoading(false);
  };

  useEffect(() => {
    if (!address) return;
    let live = true;
    void fetchPositions(address, trackedPositionIds(address)).then(r => { if (live) { setLookups(r.lookups); setLoadError(r.error); } });
    void fetchScan(address, refreshKey > 0).then(s => { if (live) setScan(s); });
    return () => { live = false; setScan(null); };
  }, [address, refreshKey]);

  const { busy, ready, setReady, error, sent, preview, confirm } = useRhcClose({ wallet, receiptPoll,
    onClosed: async () => { onChanged?.(); await load(); } });

  if (!wallet) return null;

  const add = () => {
    const id = addId.trim();
    if (!/^[0-9]{1,30}$/.test(id)) { setLoadError("Enter the position NFT number, for example 4077059."); return; }
    setAddId("");
    void load(trackPositionId(wallet.address, id));
  };
  const remove = (id: string) => { void load(untrackPositionId(wallet.address, id)); if (ready?.position.tokenId === id) setReady(null); };

  const symbols = (p: RhcPositionView | null): [string, string] => { const pool = p && poolOf(p); return pool ? [pool.currency0.symbol, pool.currency1.symbol] : ["token0", "token1"]; };

  // Wallet holdings first (newest NFT first), then local records the scan did not find (deduped by NFT id).
  const scanned = scan?.positions ?? [];
  const scannedById = new Map(scanned.map(s => [s.tokenId, s]));
  const rows: PositionLookup[] = [...scanned, ...lookups.filter(l => !scannedById.has(l.tokenId))];
  const scanning = scan === null;

  return <section className="mt-6 border-t border-white/12 pt-4" aria-label="Your Robinhood Chain positions" data-testid="positions-panel">
    <p className="text-sm font-semibold text-cream">Your positions</p>
    <p className="text-xs text-smoke">Uniswap v4 positions this wallet holds on Robinhood Chain show up here automatically. Missing one? Add its position NFT number.</p>
    <div className="mt-2 flex flex-wrap gap-2">
      <input inputMode="numeric" value={addId} onChange={e => setAddId(e.target.value)} placeholder="Position NFT #" aria-label="Position NFT number"
        className="w-40 rounded-lg bg-black/30 p-2 text-base sm:text-sm text-cream" />
      <button type="button" onClick={add} className="rounded-lg border border-white/25 px-3 py-1.5 text-xs font-semibold text-cream">Add</button>
    </div>
    {loading ? <p role="status" className="mt-2 text-xs text-smoke">Loading positions…</p> : null}
    {scanning && !loading ? <p role="status" className="mt-2 text-xs text-smoke" data-testid="positions-scanning">Checking this wallet&apos;s Robinhood Chain positions…</p> : null}
    {scan?.error ? <p className="mt-2 text-xs text-amber-200/90" data-testid="positions-scan-error">{scan.error}</p> : null}
    {loadError ? <p className="mt-2 text-xs text-red-200" data-testid="positions-error">{loadError}</p> : null}
    {!loading && !scanning && !rows.length && !loadError && !scan?.error ? <p className="mt-2 text-xs text-smoke" data-testid="positions-empty">No Robinhood Chain positions in this wallet.</p> : null}
    <ul className="mt-3 space-y-2">
      {rows.map(l => {
        const p = l.position;
        const pool = p ? poolOf(p) : null;
        const held = scannedById.get(l.tokenId);
        const closable = Boolean(p && p.ownedByUser && pool);
        const note = !p ? (l.error === "rpc" ? "Could not read this position right now." : "Closed (or never existed).")
          : !p.ownedByUser ? `Owned by another wallet (${short(p.owner)}).` : !pool ? (held ? otherPoolNote(held) : "Not in a pool SoFinance supports.") : null;
        return <li key={l.tokenId} className="rounded-xl border border-white/12 p-3" data-position={l.tokenId} data-source={held ? "wallet" : "local"}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-cream">#{l.tokenId}{pool ? ` · ${rhcPairLabel(pool.poolId, " / ")}` : ""}{p ? ` · ticks ${p.tickLower} to ${p.tickUpper}` : ""}
              {held ? <span className="ml-2 rounded-full border border-white/15 px-1.5 py-0.5 align-middle text-[10px] text-smoke" data-testid="position-in-wallet">In your wallet</span> : null}</p>
            <div className="flex gap-2">
              {closable ? <button type="button" disabled={busy !== null} onClick={() => preview(l.tokenId)}
                className="rounded-lg border border-white/25 px-3 py-1.5 text-xs font-semibold text-cream disabled:opacity-40">{busy === l.tokenId && !ready ? "Simulating…" : "Close"}</button> : null}
              {!held && (!p || !p.ownedByUser) ? <button type="button" onClick={() => remove(l.tokenId)} className="text-xs text-smoke underline">Remove</button> : null}
            </div>
          </div>
          {note ? <p className="text-xs text-smoke">{note}</p> : null}
          {p && p.ownedByUser && p.liquidity === "0" ? <p className="text-xs text-smoke">No liquidity left; closing burns the NFT and collects any remaining fees.</p> : null}
          {ready && ready.position.tokenId === l.tokenId ? <>
            <ClosePreview ready={ready} />
            <button type="button" disabled={!signingEnabled || busy !== null} onClick={confirm}
              className="mt-2 rounded-lg border border-white/25 px-3 py-1.5 text-xs font-semibold text-cream disabled:cursor-not-allowed disabled:opacity-40">
              {busy === l.tokenId ? "Waiting for wallet…" : "Confirm close in wallet"}
            </button>
            {!signingEnabled ? <p className="text-xs text-amber-200/80">Wallet signing is off on this deployment. Nothing will be sent.</p> : null}
          </> : null}
          {error && error.tokenId === l.tokenId ? <p role="alert" className="mt-2 text-xs text-red-200">{error.message}</p> : null}
          {sent && sent.tokenId === l.tokenId ? <CloseStatus sent={sent} symbols={symbols(p)} /> : null}
        </li>;
      })}
      {sent && !rows.some(l => l.tokenId === sent.tokenId) ? <li><CloseStatus sent={sent} symbols={["SPCX", "SPCXon"]} /></li> : null}
    </ul>
  </section>;
}

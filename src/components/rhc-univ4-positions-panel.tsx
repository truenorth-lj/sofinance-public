"use client";

import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import type { ExitFlowResult, PositionLookup, RhcPositionView } from "@sofinance/engine/protocols/uniswap-v4/exit-flow";
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { type Eip1193Provider, guardedWalletRequest } from "@/lib/rhc-wallet/eip1193";
import {
  checkExitTx, EXIT_EXPIRED_MESSAGE, isDeadlinePassed, trackedPositionIds, trackPositionId, untrackPositionId,
} from "@/lib/rhc-wallet/exit-execute";
import { explorerTxUrl, requireRobinhoodChain, waitForReceipt, walletTxParams } from "@/lib/rhc-wallet/open-execute";

/**
 * Robinhood Chain (4663) Uniswap v4 positions + Close (PR7), inside the `/app/rhc` panel (same flags: page behind
 * `RHC_UNIV4_TRADING_ENABLED`, server build behind `RHC_UNIV4_TX_BUILD_ENABLED`, wallet send behind
 * `RHC_UNIV4_WALLET_SIGNING_ENABLED`). Positions are read by NFT id (opened in this browser or added by hand; the v4
 * PositionManager is not enumerable). Close = server prepare (owner + allowlist checks, simulation from the owner) →
 * client guards (4663, pinned PositionManager, sender, value 0, re-decoded actions) → one `eth_sendTransaction` →
 * receipt → refresh positions and balances. No fee on exit.
 */

type Wallet = { provider: Eip1193Provider; address: `0x${string}` };
type Ready = Extract<ExitFlowResult, { state: "ready" }>;
type CloseSent = { tokenId: string; hash: string; status: "pending" | "success" | "reverted" | "timeout"; expected: Ready["expected"] };

const fmt = (raw: string | bigint, decimals = 18, digits = 6) => {
  const [i, f = ""] = formatUnits(BigInt(raw), decimals).split(".");
  const frac = f.slice(0, digits).replace(/0+$/, "");
  return frac ? `${i}.${frac}` : i!;
};
const poolOf = (p: RhcPositionView) => UNIV4_RHC_ALLOWLISTED_POOLS.find(x => x.poolId.toLowerCase() === p.poolId?.toLowerCase()) ?? null;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function ClosePreview({ ready }: { ready: Ready }) {
  const pool = poolOf(ready.position)!;
  return <div className="mt-2 space-y-1 rounded-lg border border-white/12 p-2 text-xs text-cream/90" data-testid="close-preview">
    <p>You receive ≈ {fmt(ready.expected.amount0, pool.currency0.decimals)} {pool.currency0.symbol} + {fmt(ready.expected.amount1, pool.currency1.decimals)} {pool.currency1.symbol} (includes earned pool fees)</p>
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

async function postExit<T>(body: unknown): Promise<T> {
  const response = await fetch("/api/rhc-univ4-exit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await response.json().catch(() => null) as (T & { state?: string }) | { error?: string } | null;
  if (json && "state" in json && json.state) return json as T;
  if (response.status === 404) throw new Error("Closing positions is not available on this deployment.");
  throw new Error(json && "error" in json && json.error ? json.error : "SoFinance could not reach Robinhood Chain right now. Please try again in a moment.");
}

async function fetchPositions(address: string, ids: string[]): Promise<{ lookups: PositionLookup[]; error: string | null }> {
  if (!ids.length) return { lookups: [], error: null };
  try {
    const body = await postExit<{ state: "positions"; positions: PositionLookup[] }>({ action: "positions", user: address, tokenIds: ids });
    return { lookups: Array.isArray(body.positions) ? body.positions : [], error: null };
  } catch (e) { return { lookups: [], error: e instanceof Error ? e.message : "Could not load positions" }; }
}

export function RhcUniv4PositionsPanel({ wallet, signingEnabled, refreshKey = 0, onChanged, receiptPoll }: {
  wallet: Wallet | null; signingEnabled: boolean; refreshKey?: number; onChanged?: () => void; receiptPoll?: { intervalMs?: number; timeoutMs?: number };
}) {
  const [lookups, setLookups] = useState<PositionLookup[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [addId, setAddId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [ready, setReady] = useState<Ready | null>(null);
  const [error, setError] = useState<{ tokenId: string; message: string } | null>(null);
  const [sent, setSent] = useState<CloseSent | null>(null);
  const address = wallet?.address ?? null;

  /** User-triggered refresh (add / remove / after a close). */
  const load = async (ids?: string[]) => {
    if (!address) return;
    setLoading(true);
    const r = await fetchPositions(address, ids ?? trackedPositionIds(address));
    setLookups(r.lookups); setLoadError(r.error); setLoading(false);
  };

  useEffect(() => {
    if (!address) return;
    let live = true;
    void fetchPositions(address, trackedPositionIds(address)).then(r => { if (live) { setLookups(r.lookups); setLoadError(r.error); } });
    return () => { live = false; };
  }, [address, refreshKey]);

  if (!wallet) return null;

  const add = () => {
    const id = addId.trim();
    if (!/^[0-9]{1,30}$/.test(id)) { setLoadError("Enter the position NFT number, for example 4077059."); return; }
    setAddId("");
    void load(trackPositionId(wallet.address, id));
  };
  const remove = (id: string) => { void load(untrackPositionId(wallet.address, id)); if (ready?.position.tokenId === id) setReady(null); };

  const preview = async (tokenId: string) => {
    setBusy(tokenId); setError(null); setReady(null); setSent(null);
    try {
      const body = await postExit<ExitFlowResult>({ action: "prepare", user: wallet.address, tokenId });
      if (body.state === "failed") throw new Error(body.message);
      setReady(body);
    } catch (e) { setError({ tokenId, message: e instanceof Error ? e.message : "Close preview failed" }); } finally { setBusy(null); }
  };

  const confirm = async () => {
    if (!ready) return;
    const tokenId = ready.position.tokenId;
    setBusy(tokenId); setError(null);
    try {
      if (isDeadlinePassed(ready.deadline)) { setReady(null); throw new Error(EXIT_EXPIRED_MESSAGE); }
      checkExitTx(ready.tx, wallet.address, tokenId, poolOf(ready.position)!);
      await requireRobinhoodChain(wallet.provider);
      const hash = await guardedWalletRequest(wallet.provider, "eth_sendTransaction", [walletTxParams(ready.tx)]);
      if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Your wallet did not return a transaction hash. Check the wallet's activity before trying again.");
      const expected = ready.expected;
      setReady(null);
      setSent({ tokenId, hash, status: "pending", expected });
      const receipt = await waitForReceipt(wallet.provider, hash, receiptPoll);
      const status: CloseSent["status"] = !receipt ? "timeout" : receipt.status === "0x1" ? "success" : "reverted";
      setSent({ tokenId, hash, status, expected });
      if (status !== "timeout") { onChanged?.(); await load(); }
    } catch (e) { setError({ tokenId, message: e instanceof Error ? e.message : "Close failed" }); } finally { setBusy(null); }
  };

  const symbols = (p: RhcPositionView | null): [string, string] => { const pool = p && poolOf(p); return pool ? [pool.currency0.symbol, pool.currency1.symbol] : ["token0", "token1"]; };

  return <section className="mt-6 border-t border-white/12 pt-4" aria-label="Your Robinhood Chain positions" data-testid="positions-panel">
    <p className="text-sm font-semibold text-cream">Your positions</p>
    <p className="text-xs text-smoke">Positions opened in this browser show up here. Opened elsewhere? Add the position NFT number.</p>
    <div className="mt-2 flex flex-wrap gap-2">
      <input inputMode="numeric" value={addId} onChange={e => setAddId(e.target.value)} placeholder="Position NFT #" aria-label="Position NFT number"
        className="w-40 rounded-lg bg-black/30 p-2 text-sm text-cream" />
      <button type="button" onClick={add} className="rounded-lg border border-white/25 px-3 py-1.5 text-xs font-semibold text-cream">Add</button>
    </div>
    {loading ? <p role="status" className="mt-2 text-xs text-smoke">Loading positions…</p> : null}
    {loadError ? <p className="mt-2 text-xs text-red-200" data-testid="positions-error">{loadError}</p> : null}
    {!loading && !lookups.length && !loadError ? <p className="mt-2 text-xs text-smoke" data-testid="positions-empty">No positions yet.</p> : null}
    <ul className="mt-3 space-y-2">
      {lookups.map(l => {
        const p = l.position;
        const pool = p ? poolOf(p) : null;
        const closable = Boolean(p && p.ownedByUser && pool);
        const note = !p ? (l.error === "rpc" ? "Could not read this position right now." : "Closed (or never existed).")
          : !p.ownedByUser ? `Owned by another wallet (${short(p.owner)}).` : !pool ? "Not in a pool SoFinance supports." : null;
        return <li key={l.tokenId} className="rounded-xl border border-white/12 p-3" data-position={l.tokenId}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-cream">#{l.tokenId}{pool ? ` · ${pool.currency0.symbol} / ${pool.currency1.symbol}` : ""}{p ? ` · ticks ${p.tickLower} to ${p.tickUpper}` : ""}</p>
            <div className="flex gap-2">
              {closable ? <button type="button" disabled={busy !== null} onClick={() => preview(l.tokenId)}
                className="rounded-lg border border-white/25 px-3 py-1.5 text-xs font-semibold text-cream disabled:opacity-40">{busy === l.tokenId && !ready ? "Simulating…" : "Close"}</button> : null}
              {!p || !p.ownedByUser ? <button type="button" onClick={() => remove(l.tokenId)} className="text-xs text-smoke underline">Remove</button> : null}
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
      {sent && !lookups.some(l => l.tokenId === sent.tokenId) ? <li><CloseStatus sent={sent} symbols={["SPCX", "SPCXon"]} /></li> : null}
    </ul>
  </section>;
}

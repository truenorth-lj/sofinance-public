"use client";

import { Keypair } from "@solana/web3.js";
import { useMemo, useState, useSyncExternalStore } from "react";
import { useWalletConnection } from "@/components/wallet-connection";
import type { MeteoraOpenPoolView } from "@/lib/meteora-open-view";

/**
 * Meteora DLMM open flow (design PR12), behind `METEORA_DLMM_TX_BUILD_ENABLED`. Two transactions:
 * 1/2 creates only the wallet's own accounts (position + token accounts; rent paid by the wallet and refunded on close),
 * 2/2 swaps the needed part through Jupiter (10 bps on the swapped portion only) and adds liquidity.
 * Build + simulate only: sign buttons stay disabled while `METEORA_DLMM_WALLET_SIGNING_ENABLED` is off.
 */
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PENDING_KEY = "sofinance:meteora-pending-position:v1";
const MAX_WIDTH = 70;

type Pending = { wallet: string; position: string; poolId: string; lowerBinId: number; upperBinId: number; inputMint: string; amount: string };
type ApiResult = Record<string, unknown> & { error?: string; code?: string };

const sol = (lamports: unknown) => (typeof lamports === "string" || typeof lamports === "number" ? (Number(lamports) / 1e9).toFixed(4) : "-");

export function parseUnitsString(value: string, decimals: number): string | null {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (!m) return null;
  const frac = (m[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  const raw = BigInt(m[1]! + frac);
  return raw > 0n ? raw.toString() : null;
}

export function clampRange(view: Pick<MeteoraOpenPoolView, "activeId" | "allowedLowerBinId" | "allowedUpperBinId">, below: number, above: number) {
  const lower = Math.max(view.allowedLowerBinId, view.activeId - Math.max(0, below));
  const upper = Math.min(view.allowedUpperBinId, view.activeId + Math.max(0, above), lower + MAX_WIDTH - 1);
  return { lowerBinId: lower, upperBinId: upper };
}

function subscribeStorage(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}
function readPendingRaw() {
  try { return window.localStorage.getItem(PENDING_KEY); } catch { return null; }
}
function parsePending(raw: string | null): Pending | null {
  try { return raw ? (JSON.parse(raw) as Pending) : null; } catch { return null; }
}

async function post(body: unknown): Promise<ApiResult> {
  const res = await fetch("/api/meteora-open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as ApiResult;
}

function ResultCard({ title, result }: { title: string; result: ApiResult | null }) {
  if (!result) return null;
  const rent = result.rent as Record<string, string> | undefined;
  const minimum = result.minimum as Record<string, unknown> | undefined;
  const simulation = result.simulation as Record<string, unknown> | undefined;
  const legs = (result.legs as Array<Record<string, unknown>> | undefined) ?? [];
  return <section className="mt-3 rounded-xl border border-white/12 p-3 text-sm text-cream" data-testid={`meteora-result-${title}`}>
    <p className="text-xs text-smoke">{title}</p>
    {result.error ? <p className="text-red-300" role="alert">{result.error}{result.code ? ` (${result.code})` : ""}</p> : null}
    {rent ? <p>Estimated rent: {sol(rent.totalLamports)} SOL (refundable {sol(rent.refundableLamports)} SOL when the position is closed; no new bin arrays)</p> : null}
    {minimum ? <p>Minimum SOL check: needs {sol(minimum.requiredLamports)} SOL, wallet has {sol(minimum.walletLamports)} SOL — {minimum.ok ? "OK" : "not enough"}</p> : null}
    {legs.map((leg, i) => <p key={i}>{leg.swapped ? `Swap ${leg.spend} → ${leg.side === "x" ? "X" : "Y"} (fee ${leg.feeAmount}, 10 bps via Jupiter)` : `Keep ${leg.spend} as ${leg.side === "x" ? "X" : "Y"} (no fee)`}</p>)}
    {simulation ? <p>Simulation: {simulation.ok ? "OK" : "failed"}, {String(simulation.unitsConsumed)} CU</p> : null}
    {typeof result.refundLamports === "string" ? <p>Refund on close: {sol(result.refundLamports)} SOL</p> : null}
    {typeof result.sizeBytes === "number" ? <p className="text-xs text-smoke">Transaction size {result.sizeBytes} bytes</p> : null}
  </section>;
}

export function MeteoraOpenPanel({ view, signingEnabled }: { view: MeteoraOpenPoolView | null; signingEnabled: boolean }) {
  const { address, connected, connect } = useWalletConnection();
  const [inputMint, setInputMint] = useState(USDC_MINT);
  const [amount, setAmount] = useState("1");
  const [below, setBelow] = useState(5);
  const [above, setAbove] = useState(5);
  const [setup, setSetup] = useState<ApiResult | null>(null);
  const [deposit, setDeposit] = useState<ApiResult | null>(null);
  const [close, setClose] = useState<ApiResult | null>(null);
  const [busy, setBusy] = useState(false);

  // Pending position (public key only) saved after 1/2 lands, so 2/2 can be retried or the position closed for a refund.
  const pendingRaw = useSyncExternalStore(subscribeStorage, readPendingRaw, () => null);
  const pending = useMemo(() => parsePending(pendingRaw), [pendingRaw]);

  if (!view) return <p className="text-sm text-smoke">Meteora pool state is unavailable right now.</p>;
  const range = clampRange(view, below, above);
  const decimals = inputMint === USDC_MINT ? 6 : view.decimals;
  const raw = parseUnitsString(amount, decimals);
  const wallet = address ?? "";

  async function prepareSetup() {
    if (!raw || !wallet) return;
    setBusy(true); setDeposit(null); setClose(null);
    const position = Keypair.generate().publicKey.toBase58();
    try { setSetup(await post({ action: "setup", wallet, poolId: view!.poolId, inputMint, amount: raw, position, ...range })); } finally { setBusy(false); }
  }
  async function prepareDeposit(p: Pending) {
    setBusy(true);
    try { setDeposit(await post({ action: "deposit", ...p })); } finally { setBusy(false); }
  }
  async function prepareClose(p: Pending) {
    setBusy(true);
    try { setClose(await post({ action: "close", wallet: p.wallet, poolId: p.poolId, position: p.position })); } finally { setBusy(false); }
  }

  const signNote = signingEnabled ? null : <p className="text-xs text-smoke">Signing is off in this build (build + simulate only).</p>;
  return <div className="space-y-4" data-testid="meteora-open-panel">
    <div className="rounded-xl border border-white/12 p-4 text-sm text-cream">
      <p>{view.symbolX} / {view.symbolY} · bin step {view.binStep} · active bin {view.activeId}</p>
      <p className="text-xs text-smoke">v1 opens only inside existing bin arrays: bins {view.allowedLowerBinId} to {view.allowedUpperBinId}, at most {MAX_WIDTH} bins.</p>
      {!connected ? <button type="button" className="mt-3 rounded-full border border-white/20 px-4 py-1.5" onClick={() => void connect()}>Connect wallet</button> : <p className="mt-2 text-xs text-smoke">Wallet {wallet.slice(0, 4)}…{wallet.slice(-4)}</p>}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col text-xs text-smoke">Pay with
          <select className="mt-1 rounded bg-black/30 p-2 text-cream" value={inputMint} onChange={(e) => setInputMint(e.target.value)}>
            <option value={USDC_MINT}>USDC</option><option value={view.mintX}>{view.symbolX}</option><option value={view.mintY}>{view.symbolY}</option>
          </select>
        </label>
        <label className="flex flex-col text-xs text-smoke">Amount
          <input className="mt-1 rounded bg-black/30 p-2 text-cream" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="flex flex-col text-xs text-smoke">Bins below active
          <input className="mt-1 rounded bg-black/30 p-2 text-cream" type="number" min={0} value={below} onChange={(e) => setBelow(Number(e.target.value))} />
        </label>
        <label className="flex flex-col text-xs text-smoke">Bins above active
          <input className="mt-1 rounded bg-black/30 p-2 text-cream" type="number" min={0} value={above} onChange={(e) => setAbove(Number(e.target.value))} />
        </label>
      </div>
      <p className="mt-2 text-xs text-smoke">Range: bins {range.lowerBinId} to {range.upperBinId}. SOL cannot be used as input yet.</p>
    </div>

    <ol className="space-y-3" aria-label="Open steps">
      <li className="rounded-xl border border-white/12 p-3" data-step="setup">
        <p className="text-xs text-smoke">1/2</p>
        <p className="text-sm font-semibold text-cream">Create your position account (rent paid by you, refunded on close)</p>
        <button type="button" className="mt-2 rounded-full border border-white/20 px-4 py-1.5 text-sm text-cream disabled:opacity-50" disabled={busy || !raw || !wallet} onClick={() => void prepareSetup()}>Prepare 1/2 (simulate)</button>
        <button type="button" className="ml-2 mt-2 rounded-full border border-white/20 px-4 py-1.5 text-sm text-cream disabled:opacity-50" disabled>Sign 1/2</button>
        {signNote}
        <ResultCard title="setup" result={setup} />
      </li>
      <li className="rounded-xl border border-white/12 p-3" data-step="deposit">
        <p className="text-xs text-smoke">2/2</p>
        <p className="text-sm font-semibold text-cream">Swap the needed part and add liquidity</p>
        <p className="text-xs text-smoke">Available after 1/2 confirms. If 2/2 fails you can retry it, or close the empty position to get the rent back.</p>
        <button type="button" className="mt-2 rounded-full border border-white/20 px-4 py-1.5 text-sm text-cream disabled:opacity-50" disabled={busy || !pending} onClick={() => pending && void prepareDeposit(pending)}>Retry 2/2 (simulate)</button>
        <button type="button" className="ml-2 mt-2 rounded-full border border-white/20 px-4 py-1.5 text-sm text-cream disabled:opacity-50" disabled>Sign 2/2</button>
        <button type="button" className="ml-2 mt-2 rounded-full border border-white/20 px-4 py-1.5 text-sm text-cream disabled:opacity-50" disabled={busy || !pending} onClick={() => pending && void prepareClose(pending)}>Close and refund (simulate)</button>
        {signNote}
        <ResultCard title="deposit" result={deposit} />
        <ResultCard title="close" result={close} />
      </li>
    </ol>
  </div>;
}

"use client";

import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useWalletConnection } from "@/components/wallet-connection";
import type { MeteoraOpenPoolView, MeteoraWalletBalances } from "@/lib/meteora-open-view";
import { meteoraFailedOnChainMessage, meteoraPlainError, solscanTxUrl } from "@/lib/meteora-wallet/errors";
import {
  parseMeteoraPending, readMeteoraPendingRaw, subscribeMeteoraPending, writeMeteoraPending, type MeteoraPending,
} from "@/lib/meteora-wallet/pending";

/**
 * Meteora DLMM open flow (design PR12 + signing), behind `METEORA_DLMM_TX_BUILD_ENABLED`; sign buttons need
 * `METEORA_DLMM_WALLET_SIGNING_ENABLED` (preview + development). Two transactions:
 * 1/2 creates only the wallet's own accounts (position + token accounts; rent paid by the wallet, refunded on close),
 * 2/2 swaps the needed part through Jupiter (10 bps on the swapped portion only) and adds liquidity.
 * The wallet (Phantom, Jupiter Wallet, … via the wallet adapter) signs; the server re-checks and broadcasts.
 * The position keypair lives only in memory for 1/2; only its public key is saved.
 */
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MAX_WIDTH = 70;
const POLL_MS = 2_000;
const POLL_LIMIT = 75;

type Kind = "setup" | "deposit" | "close";
type ApiResult = Record<string, unknown> & { error?: string; code?: string; transaction?: string; permit?: string; summary?: Record<string, unknown>; lastValidBlockHeight?: number };
type TxState = { phase: "idle" | "signing" | "sending" | "confirming" | "success" | "failed"; signature?: string; message?: string };

const IDLE: TxState = { phase: "idle" };
const sol = (lamports: unknown) => (typeof lamports === "string" || typeof lamports === "number" ? (Number(lamports) / 1e9).toFixed(4) : "-");
const units = (raw: string | undefined, decimals: number) => (raw ? (Number(raw) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: decimals }) : "-");

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

async function post(body: unknown): Promise<ApiResult> {
  let res: Response;
  try {
    res = await fetch("/api/meteora-open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (error) {
    return { error: meteoraPlainError(error, "network") };
  }
  return (await res.json().catch(() => ({ error: `Server error (${res.status}). Please try again.` }))) as ApiResult;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls the server until the signature is confirmed, failed or expired. */
async function waitForSignature(signature: string, lastValidBlockHeight: number): Promise<"confirmed" | "failed" | "expired" | "unknown"> {
  for (let i = 0; i < POLL_LIMIT; i++) {
    const result = await post({ action: "status", signature, lastValidBlockHeight });
    if (result.status === "confirmed" || result.status === "failed" || result.status === "expired") return result.status;
    await sleep(POLL_MS);
  }
  return "unknown";
}

function TxStatus({ state }: { state: TxState }) {
  if (state.phase === "idle") return null;
  const label = { signing: "Waiting for your wallet…", sending: "Sending…", confirming: "Confirming on Solana…", success: "Confirmed", failed: "Failed" }[state.phase];
  const busy = state.phase === "signing" || state.phase === "sending" || state.phase === "confirming";
  return <div className="mt-2 text-sm" role="status" aria-live="polite" data-phase={state.phase}>
    <p className={state.phase === "failed" ? "text-red-300" : state.phase === "success" ? "text-emerald-300" : "text-cream"}>
      {busy ? <span className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white align-middle" aria-hidden /> : null}
      {label}{state.message ? ` · ${state.message}` : ""}
    </p>
    {state.signature ? <a className="text-xs text-smoke underline" href={solscanTxUrl(state.signature)} target="_blank" rel="noopener noreferrer">View on Solscan</a> : null}
  </div>;
}

function ResultCard({ title, result }: { title: string; result: ApiResult | null }) {
  if (!result) return null;
  const rent = result.rent as Record<string, string> | undefined;
  const minimum = result.minimum as Record<string, unknown> | undefined;
  const simulation = result.simulation as Record<string, unknown> | undefined;
  const legs = (result.legs as Array<Record<string, unknown>> | undefined) ?? [];
  return <section className="mt-3 rounded-xl border border-white/12 p-3 text-sm text-cream" data-testid={`meteora-result-${title}`}>
    {result.error ? <p className="text-red-300" role="alert">{result.error}</p> : null}
    {rent ? <p>Estimated rent: {sol(rent.totalLamports)} SOL (refundable {sol(rent.refundableLamports)} SOL when you close the position; no new bin arrays)</p> : null}
    {minimum ? <p>Minimum SOL check: needs {sol(minimum.requiredLamports)} SOL, wallet has {sol(minimum.walletLamports)} SOL: {minimum.ok ? "OK" : "not enough"}</p> : null}
    {legs.map((leg, i) => <p key={i}>{leg.swapped ? `Swap ${leg.spend} → ${leg.side === "x" ? "X" : "Y"} (fee ${leg.feeAmount}, 10 bps via Jupiter)` : `Keep ${leg.spend} as ${leg.side === "x" ? "X" : "Y"} (no fee)`}</p>)}
    {simulation && !result.error ? <p>Simulation: OK, {String(simulation.unitsConsumed)} CU</p> : null}
    {typeof result.refundLamports === "string" ? <p>Refund on close: {sol(result.refundLamports)} SOL</p> : null}
  </section>;
}

export function MeteoraOpenPanel({ view, signingEnabled }: { view: MeteoraOpenPoolView | null; signingEnabled: boolean }) {
  const { address, connected, connect, signTransaction } = useWalletConnection();
  const [inputMint, setInputMint] = useState(USDC_MINT);
  const [amount, setAmount] = useState("1");
  const [below, setBelow] = useState(5);
  const [above, setAbove] = useState(5);
  const [setup, setSetup] = useState<ApiResult | null>(null);
  const [deposit, setDeposit] = useState<ApiResult | null>(null);
  const [close, setClose] = useState<ApiResult | null>(null);
  const [tx, setTx] = useState<Record<Kind, TxState>>({ setup: IDLE, deposit: IDLE, close: IDLE });
  const [balances, setBalances] = useState<MeteoraWalletBalances | null>(null);
  const [busy, setBusy] = useState(false);
  const positionKeypair = useRef<Keypair | null>(null);
  const resumed = useRef<string | null>(null);

  const pendingRaw = useSyncExternalStore(subscribeMeteoraPending, readMeteoraPendingRaw, () => null);
  const storedPending = useMemo(() => parseMeteoraPending(pendingRaw), [pendingRaw]);
  const wallet = address ?? "";
  const pending = storedPending && storedPending.wallet === wallet ? storedPending : null;
  const setTxState = useCallback((kind: Kind, state: TxState) => setTx((prev) => ({ ...prev, [kind]: state })), []);

  const refreshBalances = useCallback(async () => {
    if (!wallet) return;
    const result = await post({ action: "balances", wallet });
    if (!result.error) setBalances(result as unknown as MeteoraWalletBalances);
  }, [wallet]);

  const prepareDeposit = useCallback(async (p: MeteoraPending) => {
    setBusy(true);
    try {
      setDeposit(await post({ action: "deposit", wallet: p.wallet, poolId: p.poolId, inputMint: p.inputMint, amount: p.amount, position: p.position, lowerBinId: p.lowerBinId, upperBinId: p.upperBinId }));
    } finally { setBusy(false); }
  }, []);

  /** After a signature is known: poll, then advance the pending record. Shared by fresh sends and reload resumes. */
  const track = useCallback(async (kind: Kind, signature: string, lastValidBlockHeight: number, p: MeteoraPending) => {
    setTxState(kind, { phase: "confirming", signature });
    const outcome = await waitForSignature(signature, lastValidBlockHeight);
    void refreshBalances();
    if (outcome === "unknown") {
      setTxState(kind, { phase: "failed", signature, message: "Still not confirmed. Check Solscan; reload this page to check again." });
      return;
    }
    if (outcome !== "confirmed") {
      setTxState(kind, { phase: "failed", signature, message: outcome === "expired" ? "The transaction expired and was not processed. Please prepare it again." : meteoraFailedOnChainMessage(kind) });
      if (kind === "deposit") setDeposit(null);
      if (kind === "close") setClose(null);
      if (kind === "setup") { setSetup(null); writeMeteoraPending(null); } else writeMeteoraPending({ ...p, stage: "setup_confirmed", depositSignature: undefined, closeSignature: undefined });
      return;
    }
    if (kind === "setup") {
      const next: MeteoraPending = { ...p, stage: "setup_confirmed" };
      writeMeteoraPending(next);
      setTxState(kind, { phase: "success", signature, message: "Position account created. Now sign 2/2." });
      void prepareDeposit(next);
    } else if (kind === "deposit") {
      writeMeteoraPending(null);
      const recorded = p.setupSignature ? await post({ action: "record", wallet: p.wallet, setupSignature: p.setupSignature, depositSignature: signature }) : { error: "missing setup signature" };
      setTxState(kind, { phase: "success", signature, message: recorded.error ? "Liquidity added. (It may take a moment to show in your positions.)" : "Liquidity added. Your position is open." });
    } else {
      writeMeteoraPending(null);
      setTxState(kind, { phase: "success", signature, message: "Position closed and rent refunded to your wallet." });
    }
  }, [prepareDeposit, refreshBalances, setTxState]);

  useEffect(() => {
    if (!wallet) return;
    const timer = setTimeout(() => void refreshBalances(), 0);
    return () => clearTimeout(timer);
  }, [wallet, refreshBalances]);

  // Reload resume: keep tracking a submitted signature, or re-prepare 2/2 for a confirmed setup.
  useEffect(() => {
    if (!pending || resumed.current === `${pending.position}:${pending.stage}`) return;
    const p = pending;
    const timer = setTimeout(() => {
      resumed.current = `${p.position}:${p.stage}`;
      if (p.stage === "setup_submitted" && p.setupSignature && p.setupLastValidBlockHeight) void track("setup", p.setupSignature, p.setupLastValidBlockHeight, p);
      else if (p.stage === "deposit_submitted" && p.depositSignature && p.depositLastValidBlockHeight) void track("deposit", p.depositSignature, p.depositLastValidBlockHeight, p);
      else if (p.stage === "close_submitted" && p.closeSignature && p.closeLastValidBlockHeight) void track("close", p.closeSignature, p.closeLastValidBlockHeight, p);
    }, 0);
    return () => clearTimeout(timer);
  }, [pending, track]);

  if (!view) return <p className="text-sm text-smoke">Meteora pool state is unavailable right now.</p>;
  const range = clampRange(view, below, above);
  const decimals = inputMint === USDC_MINT ? 6 : view.decimals;
  const raw = parseUnitsString(amount, decimals);
  const anyBusy = busy || Object.values(tx).some((s) => s.phase === "signing" || s.phase === "sending" || s.phase === "confirming");

  async function prepareSetup() {
    if (!raw || !wallet) return;
    setBusy(true); setDeposit(null); setClose(null); setTx({ setup: IDLE, deposit: IDLE, close: IDLE });
    const keypair = Keypair.generate();
    positionKeypair.current = keypair;
    try { setSetup(await post({ action: "setup", wallet, poolId: view!.poolId, inputMint, amount: raw, position: keypair.publicKey.toBase58(), ...range })); } finally { setBusy(false); }
  }

  async function prepareClose(p: MeteoraPending) {
    setBusy(true);
    try { setClose(await post({ action: "close", wallet: p.wallet, poolId: p.poolId, position: p.position })); } finally { setBusy(false); }
  }

  /** Wallet signs first (Phantom guidance), then the position keypair adds its signature for 1/2. */
  async function signAndSend(kind: Kind, prepared: ApiResult, p: MeteoraPending) {
    if (!prepared.transaction || !prepared.permit || !prepared.summary) return;
    setTxState(kind, { phase: "signing" });
    let signed: VersionedTransaction;
    try {
      signed = await signTransaction(VersionedTransaction.deserialize(Buffer.from(prepared.transaction, "base64")));
      if (kind === "setup") {
        const keypair = positionKeypair.current;
        if (!keypair || keypair.publicKey.toBase58() !== p.position) throw new Error("Position key is missing. Please prepare 1/2 again.");
        signed.sign([keypair]);
      }
    } catch (error) {
      setTxState(kind, { phase: "failed", message: meteoraPlainError(error, "sign") });
      return;
    }
    const lastValidBlockHeight = Number(prepared.summary.lastValidBlockHeight);
    const submitted: MeteoraPending = kind === "setup" ? { ...p, stage: "setup_submitted" } : kind === "deposit" ? { ...p, stage: "deposit_submitted" } : { ...p, stage: "close_submitted" };
    writeMeteoraPending(submitted);
    setTxState(kind, { phase: "sending" });
    const result = await post({
      action: "send", signedTransaction: Buffer.from(signed.serialize()).toString("base64"), unsignedTransaction: prepared.transaction,
      permit: prepared.permit, summary: prepared.summary,
    });
    const signature = typeof result.signature === "string" ? result.signature : undefined;
    if (!signature) {
      // Rejected before broadcast: nothing landed, roll the pending record back.
      writeMeteoraPending(kind === "setup" ? null : p);
      setTxState(kind, { phase: "failed", message: meteoraPlainError(result.error ?? "unknown error", "send") });
      return;
    }
    if (kind === "setup") positionKeypair.current = null;
    const withSig: MeteoraPending = kind === "setup" ? { ...submitted, setupSignature: signature, setupLastValidBlockHeight: lastValidBlockHeight }
      : kind === "deposit" ? { ...submitted, depositSignature: signature, depositLastValidBlockHeight: lastValidBlockHeight }
        : { ...submitted, closeSignature: signature, closeLastValidBlockHeight: lastValidBlockHeight };
    writeMeteoraPending(withSig);
    resumed.current = `${withSig.position}:${withSig.stage}`;
    await track(kind, signature, lastValidBlockHeight, withSig);
  }

  const setupPending: MeteoraPending | null = setup?.transaction && wallet ? {
    wallet, poolId: view.poolId, position: String(setup.position), lowerBinId: Number(setup.lowerBinId), upperBinId: Number(setup.upperBinId),
    inputMint: String(setup.inputMint), amount: String(setup.amount), stage: "setup_submitted",
  } : null;
  const canSignSetup = signingEnabled && !anyBusy && Boolean(setupPending && setup?.permit) && !pending;
  const canSignDeposit = signingEnabled && !anyBusy && pending?.stage === "setup_confirmed" && Boolean(deposit?.permit && deposit.position === pending.position);
  const canSignClose = signingEnabled && !anyBusy && pending?.stage === "setup_confirmed" && Boolean(close?.permit && close.position === pending.position);
  const signNote = signingEnabled ? null : <p className="text-xs text-smoke">Signing is off in this build (build + simulate only).</p>;
  const button = "mt-2 mr-2 rounded-full border border-white/20 px-4 py-1.5 text-sm text-cream disabled:opacity-50";

  return <div className="space-y-4" data-testid="meteora-open-panel">
    <div className="rounded-xl border border-white/12 p-4 text-sm text-cream">
      <p>{view.symbolX} / {view.symbolY} · bin step {view.binStep} · active bin {view.activeId}</p>
      <p className="text-xs text-smoke">v1 opens only inside existing bin arrays: bins {view.allowedLowerBinId} to {view.allowedUpperBinId}, at most {MAX_WIDTH} bins.</p>
      {!connected ? <button type="button" className={button} onClick={() => void connect()}>Connect wallet</button> : <p className="mt-2 text-xs text-smoke">Wallet {wallet.slice(0, 4)}…{wallet.slice(-4)}</p>}
      {balances ? <p className="mt-1 text-xs text-smoke" data-testid="meteora-balances">
        Balances: {sol(balances.solLamports)} SOL · {units(balances.usdc, 6)} USDC · {units(balances.x, view.decimals)} {view.symbolX} · {units(balances.y, view.decimals)} {view.symbolY}
      </p> : null}
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

    {pending ? <div className="rounded-xl border border-amber-300/40 p-3 text-sm text-cream" data-testid="meteora-pending">
      <p>Unfinished open: position {pending.position.slice(0, 4)}…{pending.position.slice(-4)} (bins {pending.lowerBinId} to {pending.upperBinId}).</p>
      <p className="text-xs text-smoke">{pending.stage === "setup_confirmed" ? "Step 1/2 is done. Retry 2/2 to add liquidity, or close the empty position to get its rent back." : "A transaction is being confirmed…"}</p>
    </div> : null}

    <ol className="space-y-3" aria-label="Open steps">
      <li className="rounded-xl border border-white/12 p-3" data-step="setup">
        <p className="text-xs text-smoke">1/2</p>
        <p className="text-sm font-semibold text-cream">Create your position account (rent paid by you, refunded on close)</p>
        <button type="button" className={button} disabled={anyBusy || !raw || !wallet || Boolean(pending)} onClick={() => void prepareSetup()}>Prepare 1/2</button>
        <button type="button" className={button} disabled={!canSignSetup} onClick={() => setupPending && void signAndSend("setup", setup!, setupPending)}>Sign 1/2</button>
        {signNote}
        <ResultCard title="setup" result={setup} />
        <TxStatus state={tx.setup} />
      </li>
      <li className="rounded-xl border border-white/12 p-3" data-step="deposit">
        <p className="text-xs text-smoke">2/2</p>
        <p className="text-sm font-semibold text-cream">Swap the needed part and add liquidity</p>
        <p className="text-xs text-smoke">Available after 1/2 confirms. If 2/2 fails you can retry it, or close the empty position to get the rent back.</p>
        <button type="button" className={button} disabled={anyBusy || pending?.stage !== "setup_confirmed"} onClick={() => pending && void prepareDeposit(pending)}>{deposit ? "Retry 2/2" : "Prepare 2/2"}</button>
        <button type="button" className={button} disabled={!canSignDeposit} onClick={() => pending && deposit && void signAndSend("deposit", deposit, pending)}>Sign 2/2</button>
        {signNote}
        <ResultCard title="deposit" result={deposit} />
        <TxStatus state={tx.deposit} />
        <div className="mt-3 border-t border-white/10 pt-2">
          <button type="button" className={button} disabled={anyBusy || pending?.stage !== "setup_confirmed"} onClick={() => pending && void prepareClose(pending)}>Prepare close and refund</button>
          <button type="button" className={button} disabled={!canSignClose} onClick={() => pending && close && void signAndSend("close", close, pending)}>Sign close and refund</button>
          <ResultCard title="close" result={close} />
          <TxStatus state={tx.close} />
        </div>
      </li>
    </ol>
  </div>;
}

"use client";

import { VersionedTransaction } from "@solana/web3.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { createEphemeralMint, type EphemeralMint } from "@/lib/ephemeral-mint";
import { assertWalletReturnedTransaction, addMintSignature } from "@/lib/open-signatures";
import { useWalletConnection } from "@/components/wallet-connection";
import type { MeteoraOpenPoolView, MeteoraWalletBalances } from "@/lib/meteora-open-view";
import { meteoraFailedOnChainMessage, meteoraPlainError, solscanTxUrl } from "@/lib/meteora-wallet/errors";
import {
  assertMeteoraPending, METEORA_HISTORY_ERROR, parseMeteoraPending, readMeteoraPendingRaw, subscribeMeteoraPending, writeMeteoraPending, type MeteoraPending,
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
type ApiResult = Record<string, unknown> & { error?: string; code?: string; transaction?: string; permit?: string; summary?: Record<string, unknown>; lastValidBlockHeight?: number; httpOk?: boolean };
type TxState = { phase: "idle" | "signing" | "sending" | "confirming" | "success" | "failed" | "unknown"; signature?: string; message?: string };

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
    res = await fetch("/api/meteora-open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    return { error: meteoraPlainError(error, "network"), httpOk: false };
  }
  const value: unknown = await res.json().catch(() => null);
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value as ApiResult, httpOk: res.ok } : { error: `Server error (${res.status}).`, httpOk: false };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls the server until the signature is confirmed, failed or expired. */
async function waitForSignature(signature: string, lastValidBlockHeight: number, current: () => void): Promise<"confirmed" | "failed" | "expired" | "unknown"> {
  const deadline = Date.now() + POLL_MS * POLL_LIMIT;
  for (let i = 0; i < POLL_LIMIT && Date.now() < deadline; i++) {
    current();
    const result = await post({ action: "status", signature, lastValidBlockHeight });
    current();
    if (result.httpOk && result.signature === signature && (result.status === "confirmed" || result.status === "failed" || result.status === "expired")) return result.status;
    await sleep(POLL_MS);
  }
  return "unknown";
}

function TxStatus({ state }: { state: TxState }) {
  if (state.phase === "idle") return null;
  const label = { signing: "Waiting for your wallet…", sending: "Sending…", confirming: "Confirming on Solana…", success: "Confirmed", failed: "Failed", unknown: "Not yet verified" }[state.phase];
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
  const positionKeypair = useRef<EphemeralMint | null>(null);
  const resumed = useRef<string | null>(null);
  const generation = useRef<object | null>(null), revision = useRef(0), running = useRef<object | null>(null);
  const wallet = address ?? "";
  const command = useMemo(() => ({ wallet, connected, view, signingEnabled, inputMint, amount, below, above, setup, deposit, close, busy }),
    [wallet, connected, view, signingEnabled, inputMint, amount, below, above, setup, deposit, close, busy]);
  const committed = useRef<object | null>(null);
  useLayoutEffect(() => { committed.current = command; return () => { committed.current = null; }; }, [command]);
  useLayoutEffect(() => {
    generation.current = {}; resumed.current = null;
    return () => { generation.current = null; running.current = null; positionKeypair.current?.dispose(); positionKeypair.current = null; };
  }, [wallet, connected, view?.poolId, signingEnabled]);
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- A committed wallet/pool boundary discards the previous form's unsigned transactions.
    setBusy(false); setSetup(null); setDeposit(null); setClose(null); setBalances(null); setTx({ setup: IDLE, deposit: IDLE, close: IDLE });
  }, [wallet, connected, view?.poolId, signingEnabled]);

  const snapshot = useCallback(() => {
    if (!wallet) return null;
    try { return readMeteoraPendingRaw(wallet); } catch { return "unreadable"; }
  }, [wallet]);
  const pendingRaw = useSyncExternalStore(subscribeMeteoraPending, snapshot, () => null);
  const parsed = useMemo(() => parseMeteoraPending(pendingRaw), [pendingRaw]);
  const historyInvalid = pendingRaw !== null && (!parsed || parsed.wallet !== wallet);
  const pending = parsed?.wallet === wallet ? parsed : null;
  const setTxState = useCallback((kind: Kind, state: TxState) => setTx(prev => ({ ...prev, [kind]: state })), []);
  const invalidateForm = () => {
    committed.current = null; revision.current++; positionKeypair.current?.dispose(); positionKeypair.current = null;
    setSetup(null); setDeposit(null); setClose(null);
  };
  const currentOperation = () => {
    const token = generation.current, epoch = revision.current;
    return () => {
      if (!token || generation.current !== token || revision.current !== epoch) throw new Error("Wallet or form changed; check the original transaction before continuing.");
    };
  };
  const refreshBalances = useCallback(async () => {
    const token = generation.current;
    if (!wallet || !token) return;
    const result = await post({ action: "balances", wallet });
    if (generation.current === token && result.httpOk && !result.error) setBalances(result as unknown as MeteoraWalletBalances);
  }, [wallet]);
  useEffect(() => {
    const timer = setTimeout(() => void refreshBalances(), 0);
    return () => clearTimeout(timer);
  }, [refreshBalances]);

  const track = useCallback(async (kind: Kind, signature: string, height: number, p: MeteoraPending, current: () => void) => {
    const fence = () => { current(); assertMeteoraPending(p.wallet, p); };
    fence(); setTxState(kind, { phase: "confirming", signature });
    const outcome = await waitForSignature(signature, height, fence);
    fence();
    if (outcome === "unknown") {
      setTxState(kind, { phase: "unknown", signature, message: "Still unconfirmed. Check the original transaction; do not resend." });
      return;
    }
    if (outcome !== "confirmed") {
      writeMeteoraPending(p.wallet, kind === "setup" ? null : { ...p, stage: "setup_confirmed", depositSignature: undefined,
        depositLastValidBlockHeight: undefined, closeSignature: undefined, closeLastValidBlockHeight: undefined }, p);
      if (kind === "setup") setSetup(null);
      if (kind === "deposit") setDeposit(null);
      if (kind === "close") setClose(null);
      setTxState(kind, { phase: "failed", signature, message: outcome === "expired" ? "The transaction expired before landing. Prepare it again." : meteoraFailedOnChainMessage(kind) });
      return;
    }
    if (kind === "setup") {
      const next: MeteoraPending = { ...p, stage: "setup_confirmed" };
      writeMeteoraPending(p.wallet, next, p);
      setTxState(kind, { phase: "success", signature, message: "Position account created. Prepare 2/2 to continue." });
      if (next.poolId === view?.poolId) {
        const prepared = await post({ action: "deposit", wallet: next.wallet, poolId: next.poolId, position: next.position,
          inputMint: next.inputMint, amount: next.amount, lowerBinId: next.lowerBinId, upperBinId: next.upperBinId });
        current(); assertMeteoraPending(next.wallet, next);
        setDeposit(prepared);
      }
    } else {
      if (kind === "deposit") {
        writeMeteoraPending(p.wallet, null, p);
        setTxState(kind, { phase: "success", signature, message: "Liquidity added. Your position is open." });
      } else {
        writeMeteoraPending(p.wallet, null, p);
        setTxState(kind, { phase: "success", signature, message: "Position closed and rent refunded to your wallet." });
      }
    }
    void refreshBalances();
  }, [refreshBalances, setTxState, view?.poolId]);

  const recheck = useCallback(async (p: MeteoraPending) => {
    if (committed.current !== command || running.current || !connected || p.wallet !== wallet || !generation.current) return;
    const kind = p.stage === "setup_submitted" ? "setup" : p.stage === "deposit_submitted" ? "deposit" : p.stage === "close_submitted" ? "close" : null;
    if (!kind) return;
    const signature = p[`${kind}Signature`], height = p[`${kind}LastValidBlockHeight`];
    if (!signature || !height) { setTxState(kind, { phase: "unknown", message: "This older transaction record has no signature or expiry height. Check your wallet activity before continuing." }); return; }
    const token = generation.current, owner = {};
    const current = () => { if (generation.current !== token) throw new Error("Wallet changed; tracking paused."); };
    running.current = owner; setBusy(true); resumed.current = JSON.stringify(p);
    try { await track(kind, signature, height, p, current); }
    catch (error) { if (generation.current === token) setTxState(kind, { phase: "unknown", signature, message: error instanceof Error ? error.message : METEORA_HISTORY_ERROR }); }
    finally { if (running.current === owner) { running.current = null; setBusy(false); } }
  }, [command, connected, wallet, setTxState, track]);
  useEffect(() => {
    if (!pending || pending.stage === "setup_confirmed" || resumed.current === pendingRaw || running.current) return;
    const timer = setTimeout(() => void recheck(pending), 0);
    return () => clearTimeout(timer);
  }, [pending, pendingRaw, busy, recheck]);

  const range = view ? clampRange(view, below, above) : { lowerBinId: 0, upperBinId: 0 };
  const decimals = inputMint === USDC_MINT ? 6 : view?.decimals ?? 6;
  const raw = parseUnitsString(amount, decimals);
  const anyBusy = busy;
  const samePool = pending?.poolId === view?.poolId;

  async function prepare(kind: Kind, p?: MeteoraPending) {
    if (!view || !wallet || !connected || running.current || committed.current !== command || historyInvalid) return;
    if (kind === "setup" ? !raw || pending : !p || p.wallet !== wallet || p.poolId !== view.poolId || p.stage !== "setup_confirmed") return;
    committed.current = null;
    const owner = {}, token = generation.current, current = currentOperation();
    running.current = owner; setBusy(true);
    let key: EphemeralMint | null = null;
    try {
      assertMeteoraPending(wallet, p ?? null);
      if (kind === "setup") {
        positionKeypair.current?.dispose(); key = createEphemeralMint(); positionKeypair.current = key;
        setDeposit(null); setClose(null); setTx({ setup: IDLE, deposit: IDLE, close: IDLE });
      }
      const result = await post(kind === "setup"
        ? { action: kind, wallet, poolId: view.poolId, inputMint, amount: raw, position: key!.publicKey.toBase58(), ...range }
        : { action: kind, wallet, poolId: p!.poolId, position: p!.position, ...(kind === "deposit" ? { inputMint: p!.inputMint, amount: p!.amount, lowerBinId: p!.lowerBinId, upperBinId: p!.upperBinId } : {}) });
      current(); assertMeteoraPending(wallet, p ?? null);
      if (result.error || !result.httpOk) { key?.dispose(); if (positionKeypair.current === key) positionKeypair.current = null; }
      (kind === "setup" ? setSetup : kind === "deposit" ? setDeposit : setClose)(result);
    } catch (error) {
      key?.dispose(); if (positionKeypair.current === key) positionKeypair.current = null;
      if (generation.current === token) setTxState(kind, { phase: "failed", message: error instanceof Error ? error.message : "Preparation failed" });
    } finally { if (running.current === owner) { running.current = null; setBusy(false); } }
  }

  async function signAndSend(kind: Kind, prepared: ApiResult, p: MeteoraPending) {
    if (!signingEnabled || !connected || !wallet || !view || running.current || committed.current !== command || historyInvalid ||
      p.wallet !== wallet || p.poolId !== view.poolId || !prepared.transaction || !prepared.permit || !prepared.summary) return;
    const expected = kind === "setup" ? null : p;
    if (kind !== "setup" && p.stage !== "setup_confirmed") return;
    committed.current = null;
    const owner = {}, token = generation.current, current = currentOperation();
    const key = kind === "setup" ? positionKeypair.current : null;
    running.current = owner; setBusy(true); setTxState(kind, { phase: "signing" });
    let signature: string | undefined;
    let durable = false;
    try {
      current(); assertMeteoraPending(wallet, expected);
      const summary = prepared.summary;
      const height = Number(summary.lastValidBlockHeight);
      const checkSummary = () => {
        if (summary.kind !== kind || summary.wallet !== wallet || summary.poolId !== p.poolId || summary.position !== p.position ||
          !Number.isSafeInteger(summary.expiresAt) || Date.now() >= Number(summary.expiresAt) || !Number.isSafeInteger(height) || height <= 0) throw new Error("Prepared transaction expired or no longer matches this wallet and position.");
      };
      checkSummary();
      const unsigned = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, "base64"));
      const snapshot = VersionedTransaction.deserialize(unsigned.serialize());
      if (unsigned.message.staticAccountKeys[0]?.toBase58() !== wallet || unsigned.message.recentBlockhash !== summary.blockhash) throw new Error("Prepared transaction payer or blockhash mismatch");
      let signed = await signTransaction(unsigned);
      current(); assertMeteoraPending(wallet, expected); checkSummary();
      assertWalletReturnedTransaction(snapshot, signed, wallet);
      if (kind === "setup") {
        if (!key || key.publicKey.toBase58() !== p.position) throw new Error("Position key is missing. Prepare 1/2 again.");
        try { signed = addMintSignature(signed, key); } finally { key.dispose(); }
      }
      const signers = signed.message.staticAccountKeys.slice(0, signed.message.header.numRequiredSignatures);
      if (signers.length !== (kind === "setup" ? 2 : 1) || (kind === "setup" && !signers.some(k => k.toBase58() === p.position)) ||
        !signers.every((k, i) => nacl.sign.detached.verify(signed.message.serialize(), signed.signatures[i]!, k.toBytes()))) throw new Error("Wallet returned invalid transaction signatures");
      signature = bs58.encode(signed.signatures[0]!);
      const submitted: MeteoraPending = { ...p, stage: `${kind}_submitted`, [`${kind}Signature`]: signature, [`${kind}LastValidBlockHeight`]: height };
      resumed.current = JSON.stringify(submitted);
      writeMeteoraPending(wallet, submitted, expected);
      durable = true;
      current(); assertMeteoraPending(wallet, submitted);
      setTxState(kind, { phase: "sending", signature });
      const result = await post({ action: "send", signedTransaction: Buffer.from(signed.serialize()).toString("base64"), unsignedTransaction: prepared.transaction,
        permit: prepared.permit, summary });
      current();
      if (!result.httpOk && result.sent === false) {
        writeMeteoraPending(wallet, expected, submitted);
        durable = false;
        throw new Error(meteoraPlainError(result.error ?? "Transaction was not sent", "send"));
      }
      // A missing, invalid or different response signature cannot prove non-submission.
      current();
      await track(kind, signature, height, submitted, current);
    } catch (error) {
      if (generation.current === token) setTxState(kind, { phase: durable ? "unknown" : "failed", signature, message: error instanceof Error ? error.message : "Check the original transaction before continuing." });
    } finally {
      key?.dispose(); if (key && positionKeypair.current === key) positionKeypair.current = null;
      if (kind === "setup" && generation.current === token) setSetup(null);
      if (running.current === owner) { running.current = null; setBusy(false); }
    }
  }
  if (!view) return <p className="text-sm text-smoke">Meteora pool state is unavailable right now.</p>;

  const setupPending: MeteoraPending | null = setup?.transaction && wallet ? {
    wallet: String(setup.wallet), poolId: view.poolId, position: String(setup.position), lowerBinId: Number(setup.lowerBinId), upperBinId: Number(setup.upperBinId),
    inputMint: String(setup.inputMint), amount: String(setup.amount), stage: "setup_submitted",
  } : null;
  const canSignSetup = signingEnabled && connected && !historyInvalid && !anyBusy && Boolean(setupPending && setup?.permit) && !pending;
  const canSignDeposit = signingEnabled && connected && !historyInvalid && !anyBusy && samePool && pending?.stage === "setup_confirmed" && Boolean(deposit?.permit && deposit.position === pending.position);
  const canSignClose = signingEnabled && connected && !historyInvalid && !anyBusy && samePool && pending?.stage === "setup_confirmed" && Boolean(close?.permit && close.position === pending.position);
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
          <select className="mt-1 rounded bg-black/30 p-2 text-cream" value={inputMint} onChange={(e) => { invalidateForm(); setInputMint(e.target.value); }}>
            <option value={USDC_MINT}>USDC</option><option value={view.mintX}>{view.symbolX}</option><option value={view.mintY}>{view.symbolY}</option>
          </select>
        </label>
        <label className="flex flex-col text-xs text-smoke">Amount
          <input className="mt-1 rounded bg-black/30 p-2 text-cream" inputMode="decimal" value={amount} onChange={(e) => { invalidateForm(); setAmount(e.target.value); }} />
        </label>
        <label className="flex flex-col text-xs text-smoke">Bins below active
          <input className="mt-1 rounded bg-black/30 p-2 text-cream" type="number" min={0} value={below} onChange={(e) => { invalidateForm(); setBelow(Number(e.target.value)); }} />
        </label>
        <label className="flex flex-col text-xs text-smoke">Bins above active
          <input className="mt-1 rounded bg-black/30 p-2 text-cream" type="number" min={0} value={above} onChange={(e) => { invalidateForm(); setAbove(Number(e.target.value)); }} />
        </label>
      </div>
      <p className="mt-2 text-xs text-smoke">Range: bins {range.lowerBinId} to {range.upperBinId}. SOL cannot be used as input yet.</p>
    </div>

    {historyInvalid ? <p role="alert" className="text-sm text-red-300">{METEORA_HISTORY_ERROR}</p> : null}
    {pending ? <div className="rounded-xl border border-amber-300/40 p-3 text-sm text-cream" data-testid="meteora-pending">
      <p>Unfinished open: position {pending.position.slice(0, 4)}…{pending.position.slice(-4)} (bins {pending.lowerBinId} to {pending.upperBinId}).</p>
      {!samePool ? <p>Return to pool {pending.poolId} to continue this position.</p> : null}
      {pending.stage !== "setup_confirmed" ? <button type="button" className={button} disabled={anyBusy || !connected} onClick={() => void recheck(pending)}>Check original transaction</button> : null}
      <p className="text-xs text-smoke">{pending.stage === "setup_confirmed" ? "Step 1/2 is done. Retry 2/2 to add liquidity, or close the empty position to get its rent back." : "A transaction is being confirmed…"}</p>
    </div> : null}

    <ol className="space-y-3" aria-label="Open steps">
      <li className="rounded-xl border border-white/12 p-3" data-step="setup">
        <p className="text-xs text-smoke">1/2</p>
        <p className="text-sm font-semibold text-cream">Create your position account (rent paid by you, refunded on close)</p>
        <button type="button" className={button} disabled={anyBusy || !raw || !wallet || !connected || historyInvalid || Boolean(pending)} onClick={() => void prepare("setup")}>Prepare 1/2</button>
        <button type="button" className={button} disabled={!canSignSetup} onClick={() => setupPending && void signAndSend("setup", setup!, setupPending)}>Sign 1/2</button>
        {signNote}
        <ResultCard title="setup" result={setup} />
        <TxStatus state={tx.setup} />
      </li>
      <li className="rounded-xl border border-white/12 p-3" data-step="deposit">
        <p className="text-xs text-smoke">2/2</p>
        <p className="text-sm font-semibold text-cream">Swap the needed part and add liquidity</p>
        <p className="text-xs text-smoke">Available after 1/2 confirms. If 2/2 fails you can retry it, or close the empty position to get the rent back.</p>
        <button type="button" className={button} disabled={anyBusy || !connected || historyInvalid || !samePool || pending?.stage !== "setup_confirmed"} onClick={() => pending && void prepare("deposit", pending)}>{deposit ? "Retry 2/2" : "Prepare 2/2"}</button>
        <button type="button" className={button} disabled={!canSignDeposit} onClick={() => pending && deposit && void signAndSend("deposit", deposit, pending)}>Sign 2/2</button>
        {signNote}
        <ResultCard title="deposit" result={deposit} />
        <TxStatus state={tx.deposit} />
        <div className="mt-3 border-t border-white/10 pt-2">
          <button type="button" className={button} disabled={anyBusy || !connected || historyInvalid || !samePool || pending?.stage !== "setup_confirmed"} onClick={() => pending && void prepare("close", pending)}>Prepare close and refund</button>
          <button type="button" className={button} disabled={!canSignClose} onClick={() => pending && close && void signAndSend("close", close, pending)}>Sign close and refund</button>
          <ResultCard title="close" result={close} />
          <TxStatus state={tx.close} />
        </div>
      </li>
    </ol>
  </div>;
}

"use client";

import type { Univ4PoolApr } from "@sofinance/engine/protocols/uniswap-v4/market-data";
import type { OpenFlowResult, PermitJson } from "@sofinance/engine/protocols/uniswap-v4/open-flow";
import { useEffect, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import {
  connectEvmWallet, discoverEvmWallets, type Eip1193Provider, ensureRobinhoodChain, guardedWalletRequest, SIGNING_DISABLED_MESSAGE, WalletRequestError,
} from "@/lib/rhc-wallet/eip1193";
import {
  checkExecuteTx, checkTx, explorerTxUrl, isPermitExpired, mintedPositionId, requireRobinhoodChain, SIGNATURE_EXPIRED_MESSAGE, waitForReceipt, walletTxParams,
} from "@/lib/rhc-wallet/open-execute";
import { formatAprPct } from "@/lib/format-apr";
import { readWalletBalances, trackPositionId, type WalletBalances } from "@/lib/rhc-wallet/exit-execute";
import { RhcUniv4PositionsPanel } from "./rhc-univ4-positions-panel";
import { openSteps, RETRY_CONFIRM_TEXT, stepProgressLabel, type OpenStepId } from "@/lib/rhc-wallet/open-steps";

/**
 * Robinhood Chain (4663) Uniswap v4 open-position flow (design §6 PR5), behind `RHC_UNIV4_TRADING_ENABLED`.
 * Connect + chain switch are live; approve / sign / execute are wired through `guardedWalletRequest` and stay
 * disabled while `RHC_UNIV4_WALLET_SIGNING_ENABLED` is off (production). Flow: prepare → (approve) → Permit2 signature
 * → server `finalize` (re-quote + simulate) → client guards (4663, pinned UR, sender, value 0) → `execute` → receipt.
 */

export type RhcPoolView = {
  poolId: string;
  status: "listed" | "delisted";
  tick: number | null;
  price: number | null;
  token0: { address: string; symbol: string; decimals: number };
  token1: { address: string; symbol: string; decimals: number };
  estimatedApr: Univ4PoolApr | null;
};

const RANGE_PRESETS = [10, 30, 100] as const;

const fmt = (raw: string | bigint, decimals: number, digits = 6) => {
  const s = formatUnits(BigInt(raw), decimals);
  const [i, f = ""] = s.split(".");
  const frac = f.slice(0, digits).replace(/0+$/, "");
  return frac ? `${i}.${frac}` : i!;
};

/** 24h estimate; "—" when missing and "<0.01%" for tiny values (never a misleading 0.00%). */
export function EstimatedAprBadge({ apr }: { apr: Univ4PoolApr | null }) {
  if (!apr || apr.estimatedPoolFeeAprPct === null) return <span className="text-sm text-smoke">— · APR unavailable right now</span>;
  return <span className="inline-flex flex-wrap items-baseline gap-2" data-testid="estimated-apr">
    <span className="text-sm font-semibold text-cream">{formatAprPct(apr.estimatedPoolFeeAprPct)}</span>
    <span className="rounded border border-white/20 px-1.5 text-[11px] text-cream/80">{apr.label.zh} · {apr.label.en} APR · 24h</span>
    {apr.attribution
      ? <a href={apr.attribution.url} target="_blank" rel="noopener noreferrer" className="text-[11px] text-smoke underline">{apr.attribution.text}</a>
      : null}
  </span>;
}

export function StepList({ needsApproval, current, signingEnabled, onStep }: {
  needsApproval: boolean; current: OpenStepId | null; signingEnabled: boolean; onStep?: (id: OpenStepId) => void;
}) {
  return <ol className="mt-3 space-y-2" aria-label="Wallet steps">
    {openSteps(needsApproval).map(step => <li key={step.id} className="rounded-xl border border-white/12 p-3" data-step={step.id} aria-current={current === step.id ? "step" : undefined}>
      <p className="text-xs text-smoke">{stepProgressLabel(step)}</p>
      <p className="text-sm font-semibold text-cream">{step.label}</p>
      <p className="text-xs leading-5 text-cream/70">{step.detail}</p>
      <button type="button" disabled={!signingEnabled || current !== step.id} onClick={() => onStep?.(step.id)}
        className="mt-2 rounded-lg border border-white/25 px-3 py-1.5 text-xs font-semibold text-cream disabled:cursor-not-allowed disabled:opacity-40">
        {step.id === "sign" ? "Sign in wallet" : "Confirm in wallet"}
      </button>
    </li>)}
    {!signingEnabled ? <li className="text-xs text-amber-200/80" data-testid="signing-disabled">{SIGNING_DISABLED_MESSAGE}</li> : null}
  </ol>;
}

export function OpenPreview({ result, pool }: { result: OpenFlowResult; pool: RhcPoolView }) {
  if (result.state === "failed") return <div role="alert" className="mt-4 rounded-xl border border-red-400/40 p-3 text-sm text-red-200">{result.message}</div>;
  const plan = result.plan;
  const z = plan.depositToken.toLowerCase() === pool.token0.address.toLowerCase();
  const tin = z ? pool.token0 : pool.token1, tout = z ? pool.token1 : pool.token0;
  const gas = "gas" in result ? result.gas.limit : result.simulation.gasUsed;
  return <div className="mt-4 space-y-2 rounded-xl border border-white/12 p-3 text-sm text-cream/90" data-testid="open-preview">
    {result.state === "confirm_again"
      ? <p role="status" className="rounded-lg border border-amber-300/40 p-2 text-amber-100" data-testid="retry-notice">{RETRY_CONFIRM_TEXT.zh}<br />{RETRY_CONFIRM_TEXT.en}</p>
      : null}
    <p>Deposit {fmt(plan.amountIn, tin.decimals)} {tin.symbol}</p>
    {plan.kind === "swap"
      ? <p>Swap {fmt(plan.swapIn, tin.decimals)} {tin.symbol} → ≈{fmt(plan.quoteOut, tout.decimals)} {tout.symbol} (min {fmt(plan.minOut, tout.decimals)}, slippage {plan.slippageBps} bps)
          {plan.ticksCrossed.length ? `, crosses ${plan.ticksCrossed.length} tick(s)` : ""}</p>
      : <p>No swap needed: the range is on the {tin.symbol} side, so no fee.</p>}
    {plan.kind === "swap" ? <p>SoFinance fee 0.10% of the swap output: {fmt(plan.fee, tout.decimals)} {tout.symbol}</p> : null}
    <p data-testid="leftover-note">{result.leftover.message.zh}<br /><span className="text-cream/70">{result.leftover.message.en}</span></p>
    <p className="text-xs text-smoke">Simulated on Robinhood Chain at block {plan.blockNumber}; gas {"gas" in result ? "limit" : "used"} {Number(gas).toLocaleString("en-US")}.</p>
  </div>;
}

const fmtBalance = (v: bigint, decimals = 18) => { const n = Number(formatUnits(v, decimals)); return n === 0 ? "0" : n < 0.000001 ? "<0.000001" : n.toLocaleString("en-US", { maximumFractionDigits: 6 }); };

export type RhcWallet = { provider: Eip1193Provider; address: `0x${string}`; name: string };
type Wallet = RhcWallet;
type PrepareRequest = { poolId: string; user: string; depositToken: string; amount: string; tickLower: number; tickUpper: number };
type Signed = { signature: `0x${string}`; permit: PermitJson };
type Sent = { kind: "approve" | "execute"; hash: string; status: "pending" | "success" | "reverted" | "timeout"; positionId?: string | null };
type ExecResult = Extract<OpenFlowResult, { state: "ready" | "confirm_again" }>;

export function TxStatus({ sent }: { sent: Sent }) {
  const label = sent.kind === "approve" ? "Approval" : "Open transaction";
  const status = { pending: "waiting for confirmation…", success: "confirmed", reverted: "reverted", timeout: "not confirmed after 2 minutes; check the explorer" }[sent.status];
  return <p role="status" className="mt-3 text-sm text-cream/90" data-testid={`tx-${sent.kind}`}>
    {label} {status}:{" "}
    <a href={explorerTxUrl(sent.hash)} target="_blank" rel="noopener noreferrer" className="underline">{sent.hash.slice(0, 10)}…{sent.hash.slice(-6)}</a>
    {sent.positionId ? <span> · Position NFT #{sent.positionId}</span> : null}
  </p>;
}

/** Receipt poll cadence (tests pass a short one). */
export type ReceiptPoll = { intervalMs?: number; timeoutMs?: number };

/**
 * Connect MetaMask (or the first EIP-6963 wallet), switch/add Robinhood Chain 4663, and return the account. Shared by the
 * open panel and the `/app` "My positions" Robinhood section so both connect the same way.
 */
export async function connectRhcWallet(): Promise<RhcWallet> {
  const [first] = await discoverEvmWallets();
  if (!first) throw new WalletRequestError("no-account", "No EVM wallet found. Install MetaMask to continue.");
  const address = await connectEvmWallet(first.provider);
  await ensureRobinhoodChain(first.provider);
  return { provider: first.provider, address, name: first.info.name };
}

export function RhcUniv4OpenPanel({ pool, signingEnabled, receiptPoll, initialWallet = null, autoConnect = false, showPositions = true, onWalletChange, onOpened }: {
  pool: RhcPoolView | null; signingEnabled: boolean; receiptPoll?: ReceiptPoll;
  /** A wallet already connected elsewhere on the page (`/app` My positions). */
  initialWallet?: RhcWallet | null;
  /** Ask the wallet to connect as soon as the panel opens (the user just chose this Robinhood Chain pool). */
  autoConnect?: boolean;
  /** False when the page lists Robinhood Chain positions elsewhere (`/app` My positions). */
  showPositions?: boolean;
  onWalletChange?: (wallet: RhcWallet) => void;
  /** Called after an open transaction confirms and its position NFT is tracked. */
  onOpened?: (positionId: string) => void;
}) {
  const [wallet, setWallet] = useState<Wallet | null>(initialWallet);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [side, setSide] = useState<0 | 1>(0);
  const [amount, setAmount] = useState("1");
  const [halfWidth, setHalfWidth] = useState<number>(RANGE_PRESETS[0]);
  const [result, setResult] = useState<OpenFlowResult | null>(null);
  const [prepared, setPrepared] = useState<{ request: PrepareRequest } | null>(null);
  const [step, setStep] = useState<OpenStepId | null>(null);
  const [signed, setSigned] = useState<Signed | null>(null);
  const [exec, setExec] = useState<ExecResult | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const [balances, setBalances] = useState<WalletBalances | null>(null);
  const [positionsKey, setPositionsKey] = useState(0);

  const reset = () => { setResult(null); setPrepared(null); setStep(null); setSigned(null); setExec(null); setSent(null); };

  // Auto-connect once when opened from the pool list; a wallet passed in from the page is reused instead.
  // (Deferred a tick and cancelled on cleanup, so React StrictMode's double mount asks the wallet only once.)
  useEffect(() => {
    if (!pool) return;
    const tokens = [pool.token0.address, pool.token1.address];
    const loadBalances = (w: Pick<Wallet, "provider" | "address">) =>
      readWalletBalances(w.provider, w.address, tokens).then(setBalances, () => setBalances(null));
    const timer = window.setTimeout(() => {
      if (initialWallet) { void loadBalances(initialWallet); return; }
      if (!autoConnect) return;
      setError(null); setBusy(true);
      connectRhcWallet()
        .then((connected) => { setWallet(connected); onWalletChange?.(connected); void loadBalances(connected); })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : "Wallet connection failed"))
        .finally(() => setBusy(false));
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per mount
  }, []);

  if (!pool) return <p className="mt-6 text-sm text-smoke">Pool data is unavailable right now.</p>;
  const token = side === 0 ? pool.token0 : pool.token1;

  /** Read-only wallet balances (ETH for gas + both pool tokens); refreshed after every confirmed transaction. */
  const refreshBalances = async (w: Pick<Wallet, "provider" | "address"> | null = wallet) => {
    if (!w) return;
    try { setBalances(await readWalletBalances(w.provider, w.address, [pool.token0.address, pool.token1.address])); } catch { setBalances(null); }
  };

  const connect = async () => {
    setError(null); setBusy(true);
    try {
      const connected = await connectRhcWallet();
      setWallet(connected);
      onWalletChange?.(connected);
      void refreshBalances(connected);
    } catch (e) { setError(e instanceof Error ? e.message : "Wallet connection failed"); } finally { setBusy(false); }
  };

  const preview = async () => {
    if (!wallet || pool.tick === null) return;
    setError(null); setBusy(true); reset();
    try {
      let wei: bigint;
      try { wei = parseUnits(amount.trim(), token.decimals); } catch { throw new Error("Enter a valid amount"); }
      if (wei <= 0n) throw new Error("Enter a valid amount");
      const request: PrepareRequest = { poolId: pool.poolId, user: wallet.address, depositToken: token.address, amount: wei.toString(),
        tickLower: pool.tick - halfWidth, tickUpper: pool.tick + halfWidth };
      const response = await fetch("/api/rhc-univ4-open", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "prepare", ...request }) });
      const body = await response.json().catch(() => null) as OpenFlowResult | { error?: string } | null;
      if (body && "state" in body) {
        setResult(body); setPrepared({ request });
        if (body.state === "needs_signature") setStep(body.approvalTx ? "approve" : "sign");
      }
      else throw new Error(body && "error" in body && body.error ? body.error : "Preview failed");
    } catch (e) { setError(e instanceof Error ? e.message : "Preview failed"); } finally { setBusy(false); }
  };

  const fail = (e: unknown, fallback: string) => setError(e instanceof Error ? e.message : fallback);

  /** Server re-quote + simulation with the user's Permit2 signature; returns the unsigned `execute`. */
  const finalize = async (signedNow: Signed, attempt: number): Promise<boolean> => {
    if (!wallet || !prepared) return false;
    if (isPermitExpired(signedNow.permit.sigDeadline)) throw new Error(SIGNATURE_EXPIRED_MESSAGE);
    const response = await fetch("/api/rhc-univ4-open", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "finalize", ...prepared.request, attempt, signature: signedNow.signature, permit: signedNow.permit }) });
    const body = await response.json().catch(() => null) as OpenFlowResult | { error?: string } | null;
    if (!body || !("state" in body)) throw new Error(body && "error" in body && body.error ? body.error : "Finalize failed");
    if (body.state === "failed") throw new Error(/expired/i.test(body.message) ? SIGNATURE_EXPIRED_MESSAGE : body.message);
    if (body.state === "needs_signature") throw new Error("Unexpected finalize response");
    setExec(body); setStep("execute");
    return true;
  };

  const send = async (kind: Sent["kind"], tx: Parameters<typeof walletTxParams>[0]) => {
    if (!wallet) return null;
    await requireRobinhoodChain(wallet.provider);
    const hash = await guardedWalletRequest(wallet.provider, "eth_sendTransaction", [walletTxParams(tx)]);
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Your wallet did not return a transaction hash. Check the wallet's activity before trying again.");
    setSent({ kind, hash, status: "pending" });
    const receipt = await waitForReceipt(wallet.provider, hash, receiptPoll);
    const status: Sent["status"] = !receipt ? "timeout" : receipt.status === "0x1" ? "success" : "reverted";
    const positionId = kind === "execute" && receipt ? mintedPositionId(receipt, wallet.address) : null;
    setSent({ kind, hash, status, positionId });
    if (positionId) { trackPositionId(wallet.address, positionId); setPositionsKey(k => k + 1); onOpened?.(positionId); }
    if (status !== "timeout") void refreshBalances();
    return status;
  };

  const runStep = async (id: OpenStepId) => {
    if (!wallet || !result || result.state !== "needs_signature" || !prepared || busy) return;
    setError(null); setBusy(true);
    try {
      if (id === "approve" && result.approvalTx) {
        checkTx(result.approvalTx, wallet.address, prepared.request.depositToken, "Approval");
        const status = await send("approve", result.approvalTx);
        if (status === "success") setStep("sign");
        else if (status === "reverted") { setStep(null); throw new Error("Approval reverted on chain. Preview again."); }
        else if (status === "timeout") { setStep(null); throw new Error("Approval not confirmed yet. Check the explorer, then preview again."); }
      }
      if (id === "sign") {
        if (isPermitExpired(result.permit.sigDeadline)) throw new Error(SIGNATURE_EXPIRED_MESSAGE);
        const signature = await guardedWalletRequest(wallet.provider, "eth_signTypedData_v4", [wallet.address, JSON.stringify(result.typedData)]);
        if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("Wallet returned an invalid signature");
        const signedNow: Signed = { signature: signature as `0x${string}`, permit: result.permit };
        setSigned(signedNow);
        await finalize(signedNow, 0);
      }
      if (id === "execute") {
        if (!exec || !signed) return;
        if (isPermitExpired(signed.permit.sigDeadline)) throw new Error(SIGNATURE_EXPIRED_MESSAGE);
        checkExecuteTx(exec.tx, wallet.address);
        const status = await send("execute", exec.tx);
        if (status === "success" || status === "timeout") setStep(null);
        if (status === "timeout") throw new Error("Not confirmed after 2 minutes. Check the explorer before trying again; do not resend.");
        if (status === "reverted") {
          // Design §3.10: one automatic re-quote reusing the same Permit2 signature; the user confirms once more.
          // The server enforces the retry budget and returns the "price moving too fast" failure after that.
          setError("The transaction reverted on chain. Re-quoting…");
          if (await finalize(signed, exec.attempt + 1)) setError(null);
        }
      }
    } catch (e) { fail(e, "Wallet request failed"); } finally { setBusy(false); }
  };

  const needsApproval = result?.state === "needs_signature" && result.approvalTx !== null;
  const current: OpenStepId | null = busy ? null : step;

  return <section className="mt-6 rounded-2xl border border-white/12 bg-white/[0.03] p-4 sm:p-5" aria-label="Open a Robinhood Chain position">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="text-base font-semibold text-cream">{pool.token0.symbol} / {pool.token1.symbol} · Uniswap v4 · Robinhood Chain</p>
        <EstimatedAprBadge apr={pool.estimatedApr} />
      </div>
      {wallet
        ? <div className="text-right">
            <p className="text-xs text-smoke" data-testid="wallet-address">{wallet.name}: {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)} · Robinhood Chain</p>
            {balances ? <p className="text-xs text-smoke" data-testid="wallet-balances">
              {fmtBalance(balances.eth)} ETH · {fmtBalance(balances.tokens[pool.token0.address.toLowerCase()] ?? 0n, pool.token0.decimals)} {pool.token0.symbol} · {fmtBalance(balances.tokens[pool.token1.address.toLowerCase()] ?? 0n, pool.token1.decimals)} {pool.token1.symbol}
            </p> : null}
          </div>
        : <button type="button" onClick={connect} disabled={busy} className="rounded-xl border border-white/25 px-4 py-2 text-sm font-semibold text-cream disabled:opacity-40">Connect MetaMask</button>}
    </div>
    {pool.status !== "listed" ? <p role="alert" className="mt-3 text-sm text-red-200">This pool is delisted; opening is disabled.</p> : null}
    <div className="mt-4 grid gap-3 sm:grid-cols-3">
      <label className="text-xs text-smoke">Deposit token
        <select value={side} onChange={e => { setSide(Number(e.target.value) as 0 | 1); reset(); }} className="mt-1 block w-full rounded-lg bg-black/30 p-2 text-sm text-cream">
          <option value={0}>{pool.token0.symbol}</option><option value={1}>{pool.token1.symbol}</option>
        </select>
      </label>
      <label className="text-xs text-smoke">Amount
        <input inputMode="decimal" value={amount} onChange={e => { setAmount(e.target.value); reset(); }} className="mt-1 block w-full rounded-lg bg-black/30 p-2 text-sm text-cream" />
      </label>
      <label className="text-xs text-smoke">Range (minimum ±10 ticks)
        <select value={halfWidth} onChange={e => { setHalfWidth(Number(e.target.value)); reset(); }} className="mt-1 block w-full rounded-lg bg-black/30 p-2 text-sm text-cream">
          {RANGE_PRESETS.map(h => <option key={h} value={h}>±{h} ticks (≈±{((1.0001 ** h - 1) * 100).toFixed(2)}%)</option>)}
        </select>
      </label>
    </div>
    <button type="button" onClick={preview} disabled={!wallet || busy || pool.status !== "listed" || pool.tick === null}
      className="mt-4 rounded-xl border border-white/25 px-4 py-2 text-sm font-semibold text-cream disabled:opacity-40">Preview open (simulated)</button>
    {error ? <p role="alert" className="mt-3 text-sm text-red-200">{error}</p> : null}
    {result ? <OpenPreview result={exec ?? result} pool={pool} /> : null}
    {result && result.state !== "failed" ? <StepList needsApproval={needsApproval} current={current} signingEnabled={signingEnabled} onStep={runStep} /> : null}
    {sent ? <TxStatus sent={sent} /> : null}
    {showPositions ? <RhcUniv4PositionsPanel wallet={wallet} signingEnabled={signingEnabled} refreshKey={positionsKey} onChanged={() => void refreshBalances()} receiptPoll={receiptPoll} /> : null}
  </section>;
}

"use client";

import type { Univ4PoolApr } from "@sofinance/engine/protocols/uniswap-v4/market-data";
import type { OpenFlowResult } from "@sofinance/engine/protocols/uniswap-v4/open-flow";
import { useState } from "react";
import { formatUnits, parseUnits } from "viem";
import {
  connectEvmWallet, discoverEvmWallets, type Eip1193Provider, ensureRobinhoodChain, guardedWalletRequest, SIGNING_DISABLED_MESSAGE, WalletRequestError,
} from "@/lib/rhc-wallet/eip1193";
import { openSteps, RETRY_CONFIRM_TEXT, stepProgressLabel, type OpenStepId } from "@/lib/rhc-wallet/open-steps";

/**
 * Robinhood Chain (4663) Uniswap v4 open-position flow (design §6 PR5), behind `RHC_UNIV4_TRADING_ENABLED`.
 * Connect + chain switch are live; approve / sign / execute are wired through `guardedWalletRequest` and stay
 * disabled while `RHC_UNIV4_WALLET_SIGNING_ENABLED` is off (every target until PR6).
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

export function EstimatedAprBadge({ apr }: { apr: Univ4PoolApr | null }) {
  if (!apr || apr.estimatedPoolFeeAprPct === null) return <span className="text-sm text-smoke">APR unavailable</span>;
  return <span className="inline-flex flex-wrap items-baseline gap-2" data-testid="estimated-apr">
    <span className="text-sm font-semibold text-cream">{apr.estimatedPoolFeeAprPct.toFixed(2)}%</span>
    <span className="rounded border border-white/20 px-1.5 text-[11px] text-cream/80">{apr.label.zh} · {apr.label.en} APR</span>
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

type Wallet = { provider: Eip1193Provider; address: `0x${string}`; name: string };

export function RhcUniv4OpenPanel({ pool, signingEnabled }: { pool: RhcPoolView | null; signingEnabled: boolean }) {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [side, setSide] = useState<0 | 1>(0);
  const [amount, setAmount] = useState("1");
  const [halfWidth, setHalfWidth] = useState<number>(RANGE_PRESETS[0]);
  const [result, setResult] = useState<OpenFlowResult | null>(null);

  if (!pool) return <p className="mt-6 text-sm text-smoke">Pool data is unavailable right now.</p>;
  const token = side === 0 ? pool.token0 : pool.token1;

  const connect = async () => {
    setError(null); setBusy(true);
    try {
      const [first] = await discoverEvmWallets();
      if (!first) throw new WalletRequestError("no-account", "No EVM wallet found. Install MetaMask to continue.");
      const address = await connectEvmWallet(first.provider);
      await ensureRobinhoodChain(first.provider);
      setWallet({ provider: first.provider, address, name: first.info.name });
    } catch (e) { setError(e instanceof Error ? e.message : "Wallet connection failed"); } finally { setBusy(false); }
  };

  const preview = async () => {
    if (!wallet || pool.tick === null) return;
    setError(null); setBusy(true); setResult(null);
    try {
      let wei: bigint;
      try { wei = parseUnits(amount.trim(), token.decimals); } catch { throw new Error("Enter a valid amount"); }
      if (wei <= 0n) throw new Error("Enter a valid amount");
      const response = await fetch("/api/rhc-univ4-open", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "prepare", poolId: pool.poolId, user: wallet.address, depositToken: token.address, amount: wei.toString(),
          tickLower: pool.tick - halfWidth, tickUpper: pool.tick + halfWidth }) });
      const body = await response.json().catch(() => null) as OpenFlowResult | { error?: string } | null;
      if (body && "state" in body) setResult(body);
      else throw new Error(body && "error" in body && body.error ? body.error : "Preview failed");
    } catch (e) { setError(e instanceof Error ? e.message : "Preview failed"); } finally { setBusy(false); }
  };

  const runStep = async (id: OpenStepId) => {
    if (!wallet || !result || result.state !== "needs_signature") return;
    setError(null);
    try {
      if (id === "approve" && result.approvalTx) await guardedWalletRequest(wallet.provider, "eth_sendTransaction", [result.approvalTx]);
      if (id === "sign") await guardedWalletRequest(wallet.provider, "eth_signTypedData_v4", [wallet.address, JSON.stringify(result.typedData)]);
    } catch (e) { setError(e instanceof Error ? e.message : "Wallet request failed"); }
  };

  const needsApproval = result?.state === "needs_signature" && result.approvalTx !== null;
  const current: OpenStepId | null = result?.state === "needs_signature" ? (needsApproval ? "approve" : "sign") : null;

  return <section className="mt-6 rounded-2xl border border-white/12 bg-white/[0.03] p-4 sm:p-5" aria-label="Open a Robinhood Chain position">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="text-base font-semibold text-cream">{pool.token0.symbol} / {pool.token1.symbol} · Uniswap v4 · Robinhood Chain</p>
        <EstimatedAprBadge apr={pool.estimatedApr} />
      </div>
      {wallet
        ? <p className="text-xs text-smoke" data-testid="wallet-address">{wallet.name}: {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)} · Robinhood Chain</p>
        : <button type="button" onClick={connect} disabled={busy} className="rounded-xl border border-white/25 px-4 py-2 text-sm font-semibold text-cream disabled:opacity-40">Connect MetaMask</button>}
    </div>
    {pool.status !== "listed" ? <p role="alert" className="mt-3 text-sm text-red-200">This pool is delisted; opening is disabled.</p> : null}
    <div className="mt-4 grid gap-3 sm:grid-cols-3">
      <label className="text-xs text-smoke">Deposit token
        <select value={side} onChange={e => { setSide(Number(e.target.value) as 0 | 1); setResult(null); }} className="mt-1 block w-full rounded-lg bg-black/30 p-2 text-sm text-cream">
          <option value={0}>{pool.token0.symbol}</option><option value={1}>{pool.token1.symbol}</option>
        </select>
      </label>
      <label className="text-xs text-smoke">Amount
        <input inputMode="decimal" value={amount} onChange={e => { setAmount(e.target.value); setResult(null); }} className="mt-1 block w-full rounded-lg bg-black/30 p-2 text-sm text-cream" />
      </label>
      <label className="text-xs text-smoke">Range (minimum ±10 ticks)
        <select value={halfWidth} onChange={e => { setHalfWidth(Number(e.target.value)); setResult(null); }} className="mt-1 block w-full rounded-lg bg-black/30 p-2 text-sm text-cream">
          {RANGE_PRESETS.map(h => <option key={h} value={h}>±{h} ticks (≈±{((1.0001 ** h - 1) * 100).toFixed(2)}%)</option>)}
        </select>
      </label>
    </div>
    <button type="button" onClick={preview} disabled={!wallet || busy || pool.status !== "listed" || pool.tick === null}
      className="mt-4 rounded-xl border border-white/25 px-4 py-2 text-sm font-semibold text-cream disabled:opacity-40">Preview open (simulated)</button>
    {error ? <p role="alert" className="mt-3 text-sm text-red-200">{error}</p> : null}
    {result ? <OpenPreview result={result} pool={pool} /> : null}
    {result && result.state !== "failed" ? <StepList needsApproval={needsApproval} current={current} signingEnabled={signingEnabled} onStep={runStep} /> : null}
  </section>;
}

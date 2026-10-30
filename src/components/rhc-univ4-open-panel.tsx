"use client";

import type { Univ4PoolApr } from "@sofinance/engine/protocols/uniswap-v4/market-data";
import { POOL_FEE_APR_24H_SHORT } from "@/lib/apr-labels/copy";
import { exactAprTitle, formatAprPct } from "@/lib/apr-labels/format-apr";
import type { OpenFlowResult, PermitJson } from "@sofinance/engine/protocols/uniswap-v4/open-flow";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { formatUnits, parseUnits } from "viem";
import {
  connectEvmWallet, discoverEvmWallets, ensureRobinhoodChain, guardedWalletRequest, SIGNING_DISABLED_MESSAGE, WalletRequestError,
} from "@/lib/rhc-wallet/eip1193";
import {
  checkExecuteTx, checkTx, explorerTxUrl, isPermitExpired, requireRobinhoodChain, SIGNATURE_EXPIRED_MESSAGE, walletTxParams,
} from "@/lib/rhc-wallet/open-execute";
import { readWalletBalances, trackPositionId, type WalletBalances } from "@/lib/rhc-wallet/exit-execute";
import { RhcUniv4PositionsPanel } from "./rhc-univ4-positions-panel";
import { openSteps, RETRY_CONFIRM_TEXT, stepProgressLabel, type OpenStepId } from "@/lib/rhc-wallet/open-steps";
import { assertRhcOpenAttempt, clearRhcOpenAttempt, isRhcTxHash, parseRhcOpenAttempt, readRhcOpenAttempt,
  reconcileRhcOpenAttempt, rhcOpenAttemptKey, rhcOpenStorage, RHC_HISTORY_ERROR, RHC_UNKNOWN_SEND,
  subscribeRhcOpenAttempt, writeRhcOpenAttempt, type RhcOpenAttempt } from "@/lib/rhc-wallet/open-attempt";
import type { RhcPoolView } from "@/lib/rhc-wallet/pool-view";
import type { EvmWallet } from "@/lib/rhc-wallet/evm-session";

/**
 * Robinhood Chain (4663) Uniswap v4 open-position flow (design §6 PR5), behind `RHC_UNIV4_TRADING_ENABLED`.
 * Connect + chain switch are live; approve / sign / execute are wired through `guardedWalletRequest` and stay
 * disabled wherever `RHC_UNIV4_WALLET_SIGNING_ENABLED` is off. Flow: prepare → (approve) → Permit2 signature
 * → server `finalize` (re-quote + simulate) → client guards (4663, pinned UR, sender, value 0) → `execute` → receipt.
 */

export type { RhcPoolView };

const RANGE_PRESETS = [10, 30, 100] as const;

const fmt = (raw: string | bigint, decimals: number, digits = 6) => {
  const s = formatUnits(BigInt(raw), decimals);
  const [i, f = ""] = s.split(".");
  const frac = f.slice(0, digits).replace(/0+$/, "");
  return frac ? `${i}.${frac}` : i!;
};

export function EstimatedAprBadge({ apr }: { apr: Univ4PoolApr | null }) {
  // No market data (or TVL 0) is "—", never "0.00%"; a real but tiny APR is "<0.01%" with the exact value on hover.
  const value = apr?.estimatedPoolFeeAprPct;
  const label = apr?.label ?? { zh: "估計", en: "Estimated" };
  const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  const basis = apr && Number.isFinite(value) && [apr.feeRatePct, apr.volume24hUsd, apr.tvlUsd].every(Number.isFinite)
    ? `${Number(apr.feeRatePct.toPrecision(2))}% fee × ${usd(apr.volume24hUsd)} 24h vol / ${usd(apr.tvlUsd)} TVL` : null;
  return <span className="inline-flex flex-wrap items-baseline gap-2" data-testid="estimated-apr" data-apr-status={Number.isFinite(value) ? "ready" : "missing"}>
    <span className="text-sm font-semibold text-cream" title={Number.isFinite(value) ? exactAprTitle(value) : "No 24h volume / TVL from DexScreener or GeckoTerminal right now"}>{formatAprPct(value)}</span>
    {/* The 24h pool figure, labelled like the card field so it is not read as the card's 7d range headline. */}
    <span className="rounded border border-white/20 px-1.5 text-[11px] text-cream/80" title={`${label.zh} · ${label.en}`} data-testid="estimated-apr-label">{POOL_FEE_APR_24H_SHORT}</span>
    {basis ? <span className="text-[11px] text-smoke" data-testid="estimated-apr-basis">{basis}</span> : null}
    {apr?.attribution
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

export type RhcWallet = EvmWallet;
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
 * Connect MetaMask (or the first EIP-6963 wallet), switch/add Robinhood Chain 4663, and return the account. The default
 * for a standalone panel; inside the app the panel is given the shared nav session's `connect` (`useEvmWalletConnection`).
 */
export async function connectRhcWallet(): Promise<RhcWallet> {
  const [first] = await discoverEvmWallets();
  if (!first) throw new WalletRequestError("no-account", "No EVM wallet found. Install MetaMask to continue.");
  const address = await connectEvmWallet(first.provider);
  await ensureRobinhoodChain(first.provider);
  return { provider: first.provider, address, name: first.info.name };
}

export function RhcUniv4OpenPanel({ pool, signingEnabled, receiptPoll, initialWallet = null, connectWallet, autoConnect = false, showPositions = true, onWalletChange, onOpened }: {
  pool: RhcPoolView | null; signingEnabled: boolean; receiptPoll?: ReceiptPoll;
  /** A wallet already connected elsewhere on the page (`/app` My positions). */
  initialWallet?: RhcWallet | null;
  /**
   * The app-wide EVM session's `connect` (nav "EVM wallet"). When given, the panel follows `initialWallet` exactly
   * (a nav disconnect clears it here too) and its own Connect button connects that same session.
   */
  connectWallet?: () => Promise<RhcWallet>;
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

  const mounted = useRef(false), revision = useRef(0), running = useRef<object | null>(null);
  const [walletChanged, setWalletChanged] = useState(false);
  // Only a command published by the current committed render may start work.
  const command = useMemo(() => ({ wallet, pool, signingEnabled, busy, walletChanged,
    side, amount, halfWidth, result, prepared, step, signed, exec }), [wallet, pool, signingEnabled, busy, walletChanged,
    side, amount, halfWidth, result, prepared, step, signed, exec]);
  const committedCommand = useRef<object | null>(null);
  useLayoutEffect(() => {
    committedCommand.current = command;
    return () => { committedCommand.current = null; };
  }, [command]);
  useLayoutEffect(() => {
    mounted.current = true;
    revision.current += 1;
    return () => { mounted.current = false; revision.current += 1; };
  }, [wallet, pool?.poolId, pool?.status, signingEnabled, initialWallet]);
  useLayoutEffect(() => {
    if (!wallet) return;
    const invalidate = () => { committedCommand.current = null; revision.current += 1; setWalletChanged(true); };
    for (const event of ["accountsChanged", "chainChanged", "disconnect"]) wallet.provider.on?.(event, invalidate);
    return () => { for (const event of ["accountsChanged", "chainChanged", "disconnect"]) wallet.provider.removeListener?.(event, invalidate); };
  }, [wallet]);
  const getSnapshot = useCallback(() => {
    if (!wallet) return null;
    try { return rhcOpenStorage().getItem(rhcOpenAttemptKey(wallet.address)); } catch { return "unreadable"; }
  }, [wallet]);
  const rawAttempt = useSyncExternalStore(subscribeRhcOpenAttempt, getSnapshot, () => null);
  const history = useMemo(() => {
    try { return { attempt: wallet ? parseRhcOpenAttempt(rawAttempt, wallet.address) : null, invalid: false }; }
    catch { return { attempt: null, invalid: true }; }
  }, [rawAttempt, wallet]);
  const hasPending = history.invalid || Boolean(history.attempt);
  useLayoutEffect(() => {
    // A committed external wallet/pool change revokes the old preview as well as in-flight commands.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Reset form-owned transaction state at this identity boundary.
    setResult(null); setPrepared(null); setStep(null); setSigned(null); setExec(null); setSent(null);
    if (initialWallet || connectWallet) { setWallet(initialWallet); setWalletChanged(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `connectWallet` only marks the panel as following the shared session.
  }, [initialWallet, pool?.poolId]);
  const assertAvailable = () => {
    if (!wallet || !mounted.current || walletChanged || pool?.status !== "listed") throw new Error("Wallet or pool changed. Reconnect and preview again.");
    if (readRhcOpenAttempt(wallet.address)) throw new Error(RHC_UNKNOWN_SEND);
  };
  const reset = () => { committedCommand.current = null; revision.current += 1; setResult(null); setPrepared(null); setStep(null); setSigned(null); setExec(null); setSent(null); };

  // Auto-connect once when opened from the pool list; a wallet passed in from the page is reused instead.
  // (Deferred a tick and cancelled on cleanup, so React StrictMode's double mount asks the wallet only once.)
  useEffect(() => {
    if (!pool) return;
    let active = true;
    const tokens = [pool.token0.address, pool.token1.address];
    const loadBalances = (w: Pick<Wallet, "provider" | "address">) =>
      readWalletBalances(w.provider, w.address, tokens).then(value => { if (active) setBalances(value); }, () => { if (active) setBalances(null); });
    const timer = window.setTimeout(() => {
      if (initialWallet) { if (!connectWallet) void loadBalances(initialWallet); return; }
      if (!autoConnect) return;
      setError(null); setBusy(true);
      (connectWallet ?? connectRhcWallet)()
        .then((connected) => { if (!active) return; setWallet(connected); onWalletChange?.(connected); void loadBalances(connected); })
        .catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : "Wallet connection failed"); })
        .finally(() => { if (active) setBusy(false); });
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per mount
  }, []);

  // Following the shared session: a new account (or a nav disconnect) must never show the previous account's balances.
  const followedAddress = connectWallet ? wallet?.address ?? null : undefined;
  useEffect(() => {
    if (followedAddress === undefined || !pool) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Balances belong to the wallet identity that just changed.
    setBalances(null);
    if (!wallet) return;
    let active = true;
    readWalletBalances(wallet.provider, wallet.address, [pool.token0.address, pool.token1.address])
      .then(value => { if (active) setBalances(value); }, () => { if (active) setBalances(null); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the followed wallet only
  }, [wallet, followedAddress]);

  if (!pool) return <p className="mt-6 text-sm text-smoke">Pool data is unavailable right now.</p>;
  const token = side === 0 ? pool.token0 : pool.token1;

  /** Read-only wallet balances (ETH for gas + both pool tokens); refreshed after every confirmed transaction. */
  const refreshBalances = async (w: Pick<Wallet, "provider" | "address"> | null = wallet) => {
    if (!w) return;
    const epoch = revision.current;
    try {
      const value = await readWalletBalances(w.provider, w.address, [pool.token0.address, pool.token1.address]);
      if (mounted.current && revision.current === epoch) setBalances(value);
    } catch { if (mounted.current && revision.current === epoch) setBalances(null); }
  };

  const connect = async () => {
    if (running.current || committedCommand.current !== command) return;
    committedCommand.current = null;
    const owner = {}; running.current = owner;
    const epoch = revision.current;
    setError(null); setBusy(true);
    try {
      const connected = await (connectWallet ?? connectRhcWallet)();
      if (!mounted.current || revision.current !== epoch) return;
      reset(); setWalletChanged(false); setWallet(connected);
      onWalletChange?.(connected);
      void refreshBalances(connected);
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "Wallet connection failed"); } finally { if (running.current === owner) { running.current = null; if (mounted.current) setBusy(false); } }
  };

  const preview = async () => {
    if (!wallet || pool.tick === null || running.current || committedCommand.current !== command) return;
    const owner = {}; running.current = owner;
    setError(null); setBusy(true); reset();
    const epoch = revision.current;
    const current = () => mounted.current && revision.current === epoch;
    try {
      assertAvailable();
      let wei: bigint;
      try { wei = parseUnits(amount.trim(), token.decimals); } catch { throw new Error("Enter a valid amount"); }
      if (wei <= 0n) throw new Error("Enter a valid amount");
      const request: PrepareRequest = { poolId: pool.poolId, user: wallet.address, depositToken: token.address, amount: wei.toString(),
        tickLower: pool.tick - halfWidth, tickUpper: pool.tick + halfWidth };
      const response = await fetch("/api/rhc-univ4-open", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "prepare", ...request }), signal: AbortSignal.timeout(30_000) });
      const body = await response.json().catch(() => null) as OpenFlowResult | { error?: string } | null;
      if (!current()) return;
      assertAvailable();
      if (body && "state" in body) {
        setResult(body); setPrepared({ request });
        if (body.state === "needs_signature") setStep(body.approvalTx ? "approve" : "sign");
      }
      else throw new Error(body && "error" in body && body.error ? body.error : "Preview failed");
    } catch (e) { if (current()) setError(e instanceof Error ? e.message : "Preview failed"); } finally { if (running.current === owner) { running.current = null; if (mounted.current) setBusy(false); } }
  };

  const fail = (e: unknown, fallback: string) => setError(e instanceof Error ? e.message : fallback);

  /** Server re-quote + simulation with the user's Permit2 signature; returns the unsigned `execute`. */
  const finalize = async (signedNow: Signed, attempt: number, current: () => boolean): Promise<boolean> => {
    if (!wallet || !prepared) return false;
    if (isPermitExpired(signedNow.permit.sigDeadline)) throw new Error(SIGNATURE_EXPIRED_MESSAGE);
    const response = await fetch("/api/rhc-univ4-open", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "finalize", ...prepared.request, attempt, signature: signedNow.signature, permit: signedNow.permit }), signal: AbortSignal.timeout(30_000) });
    const body = await response.json().catch(() => null) as OpenFlowResult | { error?: string } | null;
    if (!body || !("state" in body)) throw new Error(body && "error" in body && body.error ? body.error : "Finalize failed");
    if (body.state === "failed") throw new Error(/expired/i.test(body.message) ? SIGNATURE_EXPIRED_MESSAGE : body.message);
    if (body.state === "needs_signature") throw new Error("Unexpected finalize response");
    if (!current()) throw new Error("Wallet or form changed; preview again.");
    assertAvailable();
    setExec(body); setStep("execute");
    return true;
  };

  const observe = async (attempt: RhcOpenAttempt, current: () => boolean) => {
    if (!wallet || !attempt.hash) throw new Error(RHC_UNKNOWN_SEND);
    setSent({ kind: attempt.kind, hash: attempt.hash, status: "pending" });
    const outcome = await reconcileRhcOpenAttempt(attempt, wallet.provider, current, receiptPoll);
    if (!current()) return null;
    if (outcome.positionId && !trackPositionId(attempt.wallet, outcome.positionId).includes(outcome.positionId)) throw new Error(RHC_HISTORY_ERROR);
    if (outcome.status !== "timeout") clearRhcOpenAttempt(attempt);
    setSent({ kind: attempt.kind, hash: attempt.hash, ...outcome });
    if (outcome.positionId) { setPositionsKey(k => k + 1); onOpened?.(outcome.positionId); }
    if (outcome.status !== "timeout") void refreshBalances();
    return outcome.status;
  };

  const send = async (kind: Sent["kind"], tx: Parameters<typeof walletTxParams>[0], current: () => boolean) => {
    if (!wallet) return null;
    await requireRobinhoodChain(wallet.provider);
    if (!current()) throw new Error("Wallet or form changed; transaction not sent.");
    const accounts = await wallet.provider.request({ method: "eth_accounts" });
    if (!current() || !Array.isArray(accounts) || typeof accounts[0] !== "string" || accounts[0].toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error("Wallet account changed; reconnect and preview again. Transaction not sent.");
    }
    assertAvailable();
    if (kind === "execute" && (!signed || isPermitExpired(signed.permit.sigDeadline))) throw new Error(SIGNATURE_EXPIRED_MESSAGE);
    const attempt: RhcOpenAttempt = { version: 1, id: crypto.randomUUID(), wallet: wallet.address, poolId: pool.poolId,
      kind, hash: null, createdAt: Date.now() };
    writeRhcOpenAttempt(attempt, null);
    if (!current()) { clearRhcOpenAttempt(attempt); throw new Error("Wallet or form changed; transaction not sent."); }
    assertRhcOpenAttempt(attempt);
    let hash: unknown;
    try { hash = await guardedWalletRequest(wallet.provider, "eth_sendTransaction", [walletTxParams(tx)]); }
    catch (e) {
      if (e instanceof WalletRequestError && (e.code === "rejected" || e.code === "signing-disabled")) clearRhcOpenAttempt(attempt);
      throw e;
    }
    if (!isRhcTxHash(hash)) throw new Error(RHC_UNKNOWN_SEND);
    // Keep the returned hash even if the panel closed or the wallet changed during its prompt.
    const sentAttempt = { ...attempt, hash };
    if (current()) setSent({ kind, hash, status: "pending" });
    writeRhcOpenAttempt(sentAttempt, attempt);
    if (!current()) return null;
    return observe(sentAttempt, current);
  };

  const recheck = async () => {
    if (!wallet || running.current || !history.attempt?.hash || committedCommand.current !== command) return;
    committedCommand.current = null;
    const owner = {}; running.current = owner;
    const epoch = revision.current;
    const current = () => mounted.current && revision.current === epoch;
    setBusy(true); setError(null);
    // Recovery settles history only; it cannot reactivate an old execute or Permit2 signature.
    setStep(null); setExec(null); setSigned(null); setPrepared(null); setResult(null);
    try { await observe(history.attempt, current); }
    catch (e) { if (current()) fail(e, "Unable to check the original transaction"); }
    finally { if (running.current === owner) { running.current = null; if (mounted.current) setBusy(false); } }
  };

  const runStep = async (id: OpenStepId) => {
    if (!wallet || !result || result.state !== "needs_signature" || !prepared || busy || running.current || id !== step || !signingEnabled || committedCommand.current !== command) return;
    committedCommand.current = null;
    const owner = {}; running.current = owner;
    const epoch = revision.current;
    const current = () => mounted.current && revision.current === epoch && running.current === owner;
    setError(null); setBusy(true);
    try {
      assertAvailable();
      if (prepared.request.poolId !== pool.poolId || prepared.request.user.toLowerCase() !== wallet.address.toLowerCase()) throw new Error("Preview belongs to a different wallet or pool. Preview again.");
      if (id === "approve" && result.approvalTx) {
        checkTx(result.approvalTx, wallet.address, prepared.request.depositToken, "Approval");
        const status = await send("approve", result.approvalTx, current);
        if (!current()) return;
        if (status === "success") setStep("sign");
        else if (status === "reverted") { setStep(null); throw new Error("Approval reverted on chain. Preview again."); }
        else if (status === "timeout") { setStep(null); throw new Error("Approval not confirmed yet. Check the explorer, then preview again."); }
      }
      if (id === "sign") {
        if (isPermitExpired(result.permit.sigDeadline)) throw new Error(SIGNATURE_EXPIRED_MESSAGE);
        await requireRobinhoodChain(wallet.provider);
        const accounts = await wallet.provider.request({ method: "eth_accounts" });
        if (!current() || !Array.isArray(accounts) || typeof accounts[0] !== "string" || accounts[0].toLowerCase() !== wallet.address.toLowerCase()) throw new Error("Wallet or form changed; preview again.");
        assertAvailable();
        if (isPermitExpired(result.permit.sigDeadline)) throw new Error(SIGNATURE_EXPIRED_MESSAGE);
        const signature = await guardedWalletRequest(wallet.provider, "eth_signTypedData_v4", [wallet.address, JSON.stringify(result.typedData)]);
        if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("Wallet returned an invalid signature");
        const signedNow: Signed = { signature: signature as `0x${string}`, permit: result.permit };
        if (!current()) return;
        assertAvailable();
        setSigned(signedNow);
        await finalize(signedNow, 0, current);
      }
      if (id === "execute") {
        if (!exec || !signed) return;
        if (isPermitExpired(signed.permit.sigDeadline)) throw new Error(SIGNATURE_EXPIRED_MESSAGE);
        checkExecuteTx(exec.tx, wallet.address);
        const status = await send("execute", exec.tx, current);
        if (!current()) return;
        if (status === "success" || status === "timeout") setStep(null);
        if (status === "timeout") throw new Error("Not confirmed after 2 minutes. Check the explorer before trying again; do not resend.");
        if (status === "reverted") {
          // Design §3.10: one automatic re-quote reusing the same Permit2 signature; the user confirms once more.
          // The server enforces the retry budget and returns the "price moving too fast" failure after that.
          setError("The transaction reverted on chain. Re-quoting…");
          if (await finalize(signed, exec.attempt + 1, current)) setError(null);
        }
      }
    } catch (e) { if (current()) fail(e, "Wallet request failed"); } finally { if (running.current === owner) { running.current = null; if (mounted.current) setBusy(false); } }
  };

  const needsApproval = result?.state === "needs_signature" && result.approvalTx !== null;
  const current: OpenStepId | null = busy || hasPending || walletChanged ? null : step;

  return <section className="mt-6 rounded-2xl border border-white/12 bg-white/[0.03] p-4 sm:p-5" aria-label="Open a Robinhood Chain position">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="text-base font-semibold text-cream">{pool.token0.symbol} / {pool.token1.symbol} · Uniswap v4 · Robinhood Chain</p>
        <EstimatedAprBadge apr={pool.estimatedApr} />
      </div>
      {wallet && !walletChanged
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
    <button type="button" onClick={preview} disabled={!wallet || busy || hasPending || walletChanged || pool.status !== "listed" || pool.tick === null}
      className="mt-4 rounded-xl border border-white/25 px-4 py-2 text-sm font-semibold text-cream disabled:opacity-40">Preview open (simulated)</button>
    {hasPending ? <div className="mt-3 rounded-xl border border-amber-300/40 p-3 text-sm" role="status">
      <p>{history.invalid ? RHC_HISTORY_ERROR : history.attempt?.hash ? "Check the original Robinhood Chain transaction before opening again." : RHC_UNKNOWN_SEND}</p>
      {history.attempt?.hash ? <>
        <TxStatus sent={{ kind: history.attempt.kind, hash: history.attempt.hash, status: "pending" }} />
        <button type="button" disabled={busy} onClick={() => void recheck()} className="mt-2 underline disabled:opacity-40">Check original transaction</button>
      </> : null}
    </div> : null}
    {error ? <p role="alert" className="mt-3 text-sm text-red-200">{error}</p> : null}
    {result ? <OpenPreview result={exec ?? result} pool={pool} /> : null}
    {result && result.state !== "failed" ? <StepList needsApproval={needsApproval} current={current} signingEnabled={signingEnabled} onStep={runStep} /> : null}
    {sent && !history.attempt?.hash ? <TxStatus sent={sent} /> : null}
    {showPositions ? <RhcUniv4PositionsPanel wallet={wallet} signingEnabled={signingEnabled} refreshKey={positionsKey} onChanged={() => void refreshBalances()} receiptPoll={receiptPoll} /> : null}
  </section>;
}

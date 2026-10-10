"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUpRight, ChartNoAxesCombined, CircleAlert, LoaderCircle, Sprout } from "lucide-react";
import { assetMetadata, assetSymbol, TokenPicker } from "./token-picker";
import { formatAmount } from "@/lib/amount";
import { NATIVE_SOL_MINT, USDC_MINT } from "@/lib/ids";
import { PositionSelect } from "./position-select";
import { useTokenMetadata } from "./use-token-metadata";
import { useSelectedController } from "./use-selected-controller";
import { TransactionStatusDialog } from "./transaction-status-dialog";
import { CompoundPanel } from "./compound-panel";
import { useCompoundController } from "./use-compound-controller";
import { InkHero, InkNav } from "./ink";
import { PoolActivityPanel } from "./pool-activity-panel";
import { PositionPerformancePanel } from "./position-performance-panel";
import { ConnectWalletPrompt } from "./connect-wallet-prompt";

const short = (value: string) => `${value.slice(0, 5)}…${value.slice(-5)}`;
const money = (value: string, decimals: number, digits = 6) => formatAmount(value, decimals, digits);
const tokenLabel = (mint: string, kind?: "native" | "token") =>
  kind === "native" ? "SOL" : mint === USDC_MINT ? "USDC" : mint === NATIVE_SOL_MINT ? "WSOL" : short(mint);

function calculateInputUsd(amount: string, priceUsd: number | null): string | null {
  if (!amount || priceUsd === null || !Number.isFinite(priceUsd) || priceUsd < 0) return null;
  try {
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    const usdValue = parsed * priceUsd;
    if (!Number.isFinite(usdValue)) return null;
    return usdValue < 0.01 ? "< $0.01" : `≈ $${usdValue.toFixed(2)}`;
  } catch {
    return null;
  }
}

export function SelectedApp({ initialView = "compound", initialMint = "", initialWallet = "", previewPoolId = "" }: {
  initialView?: "compound" | "performance" | "deposit";
  initialMint?: string;
  initialWallet?: string;
  previewPoolId?: string;
} = {}) {
  const controller = useSelectedController();
  const { wallet, connected, connect, disconnect, connectionError,
    discovery, selection, state, amount, maxCostPercent, tolerancePercent, result, attempt, attemptStatus,
    obsoletePending, error, quoteError, busy: addBusy, calculating, now, floorBps, quote, fresh, status,
    actionLabel, actionDisabled: addDisabled, primaryAction: addAction, changeAmount, changeMaxCost, changeTolerance, fillMax,
    choosePosition, chooseAsset, refreshDiscovery, refreshState, retryCalculation, retryReconcile, retryObsoleteReconcile, clearObsoleteRecords,
    clearInvalidAttempt } = controller;
  const compound = useCompoundController({ wallet: wallet || undefined, positionMint: selection?.positionMint,
    externalBlocked: controller.walletBlocked,
    onConfirmed: () => { void refreshState(); } });
  const busy = addBusy || compound.busy;
  const actionDisabled = connected && (addDisabled || compound.walletBlocked);
  const primaryAction = () => { if (!connected) { connect(); return; } if (!compound.walletBlocked) addAction(); };
  const metadataMints = [
    ...(discovery?.assets.map((asset) => asset.mint) || []),
    ...(discovery?.positions.flatMap((item) => [item.mintA, item.mintB]) || []),
  ];
  const metadata = useTokenMetadata(metadataMints);
  const [statusDialogOpen, setStatusDialogOpen] = useState(false);
  const [activeView, setActiveView] = useState<"compound" | "performance" | "deposit">(initialView);
  const linkedPositionApplied = useRef(false);
  useEffect(() => {
    if (linkedPositionApplied.current || !initialMint || !discovery) return;
    if (discovery.positions.some((position) => position.positionMint === initialMint)) {
      linkedPositionApplied.current = true;
      choosePosition(initialMint);
    }
  }, [initialMint, discovery, choosePosition]);
  const shownSignatureRef = useRef<string | null>(null);
  const visibleAttempt = attempt?.wallet === wallet ? attempt : null;
  useEffect(() => {
    const timer = window.setTimeout(() => { shownSignatureRef.current = null; setStatusDialogOpen(false); }, 0);
    return () => window.clearTimeout(timer);
  }, [wallet]);
  useEffect(() => {
    if (!visibleAttempt || shownSignatureRef.current === visibleAttempt.signature) return;
    const signature = visibleAttempt.signature;
    const terminalKey = `sofinance:status-dialog-terminal:${visibleAttempt.wallet}`;
    const alreadyTerminal = window.localStorage.getItem(terminalKey) === signature;
    const timer = window.setTimeout(() => {
      shownSignatureRef.current = signature;
      if (!alreadyTerminal) setStatusDialogOpen(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [visibleAttempt]);
  useEffect(() => {
    if (visibleAttempt && ["success", "failed", "expired"].includes(attemptStatus || "")) {
      window.localStorage.setItem(`sofinance:status-dialog-terminal:${visibleAttempt.wallet}`, visibleAttempt.signature);
    }
  }, [visibleAttempt, attemptStatus]);
  const selectedAsset = discovery?.assets.find((asset) => asset.kind === selection?.inputKind && asset.mint === selection?.inputMint);
  const inputLabel = selectedAsset ? assetSymbol(selectedAsset, assetMetadata(selectedAsset, metadata)) : "Input asset";
  const positionOptions = discovery?.positions || [];
  const assetOptions = discovery?.assets || [];
  const poolLabel = (mint: string) => {
    const asset = assetOptions.find((item) => item.mint === mint);
    return asset ? assetSymbol(asset, assetMetadata(asset, metadata)) : tokenLabel(mint);
  };
  return <div className="min-h-screen bg-canvas text-cream">
    <div className="relative mx-auto max-w-[1280px] px-3 pb-32 pt-3 sm:px-5 sm:pt-5">
      <InkNav wallet={wallet} connected={connected} onConnect={connect} onDisconnect={disconnect} />

      <div className="mt-3 grid gap-3 lg:grid-cols-12">
      <InkHero stacked className="mt-0 lg:col-span-7" label="Positions" title="Manage my liquidity positions">Add yield back to original position, or invest new capital.</InkHero>

      <section aria-labelledby="position-heading" className="flex flex-col justify-center rounded-[28px] border border-white/12 bg-char p-5 sm:p-7 lg:col-span-5">
        <div className="flex items-center justify-between gap-3"><h2 id="position-heading" className="text-base font-semibold text-cream">My positions</h2><button type="button" disabled={!wallet || busy} onClick={() => void refreshDiscovery()} className="text-xs font-semibold text-cream/80 transition-opacity hover:opacity-70 disabled:opacity-40">Rescan wallet</button></div>
        {connected ? <PositionSelect
          id="position"
          label="Select Raydium position"
          labelSrOnly
          value={selection?.positionMint || ""}
          disabled={!positionOptions.length || busy}
          onChange={choosePosition}
          positions={positionOptions}
          metadata={metadata}
          placeholder={!positionOptions.length ? (connected ? "No identifiable position found" : "Connect wallet to view positions") : undefined}
          className="mt-3 w-full rounded-2xl border border-white/20 bg-white/[0.06] px-3 py-3 text-sm text-cream outline-none focus:border-white/40"
        /> : <div className="mt-3"><ConnectWalletPrompt onConnect={connect} /></div>}
        {connected && discovery && positionOptions.length === 0 && <a href="/app/rwa-pairs" className="mt-3 text-sm font-semibold text-cream underline underline-offset-4">Explore RWA Pairs to open a position</a>}
        {state && <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs">
          <span className={`rounded-full border px-2.5 py-1 ${state.inRange ? "border-white/40 bg-white/[0.07] text-cream/80" : "border-white/20 bg-white/[0.05] text-smoke"}`}>{state.rangeSide === "above" ? "Above range · single-sided" : state.rangeSide === "below" ? "Below range · single-sided" : "Price within range"}</span>
          <span className="text-smoke">Position assets: {money(state.currentAmounts.a, state.decimalsA)} {poolLabel(state.mintA)}  +  {money(state.currentAmounts.b, state.decimalsB)} {poolLabel(state.mintB)}</span>
        </div>}
        {connected && <details className="mt-5 border-t border-white/10 pt-4 text-xs text-smoke"><summary className="cursor-pointer font-semibold text-cream/80">Detailed information and asset risks</summary><div className="mt-4 space-y-2 break-all leading-5">{state && <><p>Real-time pool price: {Number(state.price).toPrecision(8)} · ticks {state.tickLower}–{state.tickUpper} · slot {state.slot}</p><p>Wallet pool asset balance: {money(state.balances.a, state.decimalsA)} {poolLabel(state.mintA)}  +  {money(state.balances.b, state.decimalsB)} {poolLabel(state.mintB)} · SOL {money(String(state.solLamports), 9)}</p><button type="button" onClick={() => void refreshState()} disabled={busy} className="text-cream/80 underline disabled:opacity-40">Reload on-chain</button><p>Pool: <a className="text-cream/80 underline" href={`https://solscan.io/account/${state.poolId}`} target="_blank" rel="noreferrer">{state.poolId} <ArrowUpRight className="inline h-3 w-3" /></a></p><p>Position NFT: {state.positionMint}</p><p>Pool A mint: {state.mintA}</p><p>Pool B mint: {state.mintB}</p><p>Input mint: {selection?.inputMint}</p></>}<p>Different tokens may have issuer, transfer restrictions, or routing liquidity risks. APR does not represent this position&apos;s realizable returns; no trading fees earned for this range while outside.</p></div></details>}
      </section>
      </div>

      {state?.poolId && (
        <div className="mt-3">
          <PoolActivityPanel
            poolId={state.poolId}
            tickLower={state.tickLower}
            tickUpper={state.tickUpper}
            decimalsA={state.decimalsA}
            decimalsB={state.decimalsB}
            mintA={state.mintA}
            mintB={state.mintB}
          />
        </div>
      )}

      <nav aria-label="Position operations" className="mt-3 flex gap-1.5 rounded-full border border-white/12 bg-char p-1.5">
        <button type="button" aria-pressed={activeView === "compound"} aria-controls="compound-view" onClick={() => setActiveView("compound")} className={`flex flex-1 items-center justify-center gap-2 rounded-full px-3 py-3 text-sm font-semibold transition-colors ${activeView === "compound" ? "bg-lemon text-ink" : "text-smoke hover:text-cream/80"}`}><Sprout className="h-4 w-4" />Yield Compound</button>
        <button type="button" aria-pressed={activeView === "performance"} aria-controls="performance-view" onClick={() => setActiveView("performance")} className={`flex flex-1 items-center justify-center gap-2 rounded-full px-3 py-3 text-sm font-semibold transition-colors ${activeView === "performance" ? "bg-lemon text-ink" : "text-smoke hover:text-cream/80"}`}><ChartNoAxesCombined className="h-4 w-4" />Performance</button>
        <button type="button" aria-pressed={activeView === "deposit"} aria-controls="deposit-view" onClick={() => setActiveView("deposit")} className={`flex flex-1 items-center justify-center gap-2 rounded-full px-3 py-3 text-sm font-semibold transition-colors ${activeView === "deposit" ? "bg-lemon text-ink" : "text-smoke hover:text-cream/80"}`}><ArrowDown className="h-4 w-4" />Deposit funds</button>
      </nav>
      {controller.walletBlocked && activeView === "compound" && <div role="status" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-xs text-cream/80"><span>Deposit transaction pending verification, new transactions paused.</span><button type="button" className="font-semibold underline" onClick={() => { setActiveView("deposit"); if (visibleAttempt) setStatusDialogOpen(true); }}>View deposit transaction</button></div>}
      {compound.walletBlocked && activeView === "deposit" && <div role="status" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-xs text-cream/80"><span>Compound or yield recovery transaction pending verification, new transactions paused.</span><button type="button" className="font-semibold underline" onClick={() => setActiveView("compound")}>View compound status</button></div>}
      <main>
        <div id="compound-view" hidden={activeView !== "compound"}>
          <CompoundPanel controller={compound} tokenLabel={poolLabel} onConnect={connect} />
        </div>
        <div id="performance-view" hidden={activeView !== "performance"} className="mt-3 space-y-3">
          {activeView === "performance" && <PositionPerformancePanel embedded selectedMint={selection?.positionMint || initialMint} initialWallet={initialWallet} previewPoolId={previewPoolId} />}
        </div>
        <div id="deposit-view" hidden={activeView !== "deposit"}>
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)]">
        <section className="min-w-0 rounded-[28px] border border-white/12 bg-char p-5 sm:p-8">
          <h2 className="text-lg font-semibold text-cream">Deposit funds</h2><p className="mt-2 text-xs leading-5 text-smoke">Select wallet assets, swap and add to position selected above.</p>
          <span id="asset-label" className="mt-6 block text-xs font-medium uppercase tracking-[0.16em] text-smoke">From wallet deposit</span>
          <TokenPicker assets={assetOptions} selectedAsset={selectedAsset} metadata={metadata} disabled={!assetOptions.length || busy} onSelect={chooseAsset} inputPriceUsd={state?.pricing?.priceUsdInput} />
          {selectedAsset && <details className="mt-2 text-[11px] leading-5 text-smoke/70"><summary className="cursor-pointer">Asset address and balance source</summary><p className="mt-2 break-all">Mint {selectedAsset.mint} · Available for input ATA/SOL balance {money(selectedAsset.balance, selectedAsset.decimals, selectedAsset.decimals)}{selectedAsset.totalBalance !== selectedAsset.balance ? `; wallet total holdings ${money(selectedAsset.totalBalance, selectedAsset.decimals, selectedAsset.decimals)}` : ""}</p></details>}
          <label htmlFor="amount" className="mt-7 block text-xs font-medium uppercase tracking-[0.16em] text-smoke">Input limit</label>
          <div className="mt-2 flex items-center gap-2 rounded-2xl border border-white/20 bg-white/[0.06] px-4 py-3 focus-within:border-white/40"><input id="amount" disabled={busy || !selection} inputMode="decimal" placeholder="Enter amount" value={amount} onChange={(event) => changeAmount(event.target.value)} className="min-w-0 flex-1 bg-transparent text-3xl font-semibold text-cream outline-none placeholder:text-smoke/50" /><span className="text-sm font-semibold text-cream/80">{inputLabel}</span></div>
          {state?.pricing?.priceUsdInput !== undefined && state.pricing.priceUsdInput !== null && amount && (() => {
            const inputUsd = calculateInputUsd(amount, state.pricing.priceUsdInput);
            return inputUsd ? <div className="mt-2 text-center text-sm text-smoke/70">{inputUsd}</div> : null;
          })()}
          <div className="mt-3 flex items-center justify-between text-xs text-smoke"><span>Available for input balance: {state ? `${money(state.inputBalance, state.inputDecimals, state.inputDecimals)} ${inputLabel}` : "—"}</span><button type="button" className="font-semibold text-cream/80 hover:text-cream disabled:opacity-40" onClick={fillMax} disabled={busy || !state}>MAX</button></div>
          <details className="mt-5 text-xs text-smoke"><summary className="cursor-pointer font-semibold">Advanced settings · Max resale difference {maxCostPercent}% · Price tolerance {tolerancePercent}%</summary>
          <div className="mt-3 flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3"><div><label htmlFor="max-cost" className="text-sm font-medium text-cream/80">Maximum estimated immediate resale difference</label><p className="mt-1 text-xs leading-5 text-smoke">Estimated ratio to swap back to same input asset; can set 0–5%, by 0.1%. Transaction slippage fixed at 0.5%.</p></div><div className="flex shrink-0 items-center gap-1"><input id="max-cost" disabled={busy} type="number" inputMode="decimal" min="0" max="5" step="0.1" value={maxCostPercent} onChange={(event) => changeMaxCost(event.target.value)} className="w-16 rounded-lg border border-white/20 bg-white/10 px-2 py-1.5 text-right text-sm font-semibold text-cream outline-none focus:border-white/40" /><span className="text-sm text-cream/80">%</span></div></div>
          <div className="mt-3 flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3"><div><label htmlFor="tolerance" className="text-sm font-medium text-cream/80">Add-liquidity price tolerance</label><p className="mt-1 text-xs leading-5 text-smoke">Room for the pool price to move before execution; 0–5%, by 0.1%. The unused reserve stays in your wallet as pool assets.</p></div><div className="flex shrink-0 items-center gap-1"><input id="tolerance" disabled={busy} type="number" inputMode="decimal" min="0" max="5" step="0.1" value={tolerancePercent} onChange={(event) => changeTolerance(event.target.value)} className="w-16 rounded-lg border border-white/20 bg-white/10 px-2 py-1.5 text-right text-sm font-semibold text-cream outline-none focus:border-white/40" /><span className="text-sm text-cream/80">%</span></div></div>
          </details>
          <p className="mt-5 text-xs leading-5 text-smoke">Auto-calculated after entering amount; will re-simulate with latest quote before signing, and confirmed by wallet.</p>
          <div className="mt-6 hidden sm:block"><button className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-lemon px-5 py-4 text-sm font-semibold text-ink transition-colors hover:bg-[#fff27f] disabled:cursor-not-allowed disabled:opacity-40" disabled={actionDisabled} onClick={primaryAction}>{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ArrowDown className="h-4 w-4" />}{connected ? actionLabel : "Connect wallet"}</button></div>
          {connected && <div role="status" className="mt-3 min-h-5 text-xs text-smoke">{status}</div>}
          {attemptStatus === "manual-review" && !attempt && <button type="button" className="mt-2 text-xs text-cream/80 underline" onClick={clearInvalidAttempt}>Clear invalid new version records after self-verification on-chain</button>}
          {obsoletePending && <button type="button" className="mt-2 text-xs text-cream/80 underline" onClick={retryObsoleteReconcile}>Re-verify previous version transaction</button>}
          {obsoletePending && <button type="button" className="ml-4 mt-2 text-xs text-smoke underline" onClick={clearObsoleteRecords}>Clear previous version records after self-verification on-chain</button>}
          {connectionError && <div role="alert" className="mt-4 flex gap-2 rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-sm text-cream/80"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />{connectionError}</div>}
          {error && <div role="alert" className="mt-4 flex gap-2 rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-sm text-cream/80"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /><span className="flex-1">{error}</span>{quoteError && <button type="button" onClick={retryCalculation} className="shrink-0 font-semibold underline">Recalculate</button>}</div>}
        </section>

        <aside className="min-w-0 space-y-3"><section className="rounded-[28px] border border-white/12 bg-char p-5 sm:p-7"><h2 className="text-lg font-semibold text-cream">Deposit preview</h2><p className="mt-2 text-xs leading-5 text-smoke">{calculating ? <span role="status" className="inline-flex items-center gap-2 text-cream/80"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Calculating deposit estimates and transaction checks…</span> : quote ? fresh ? `Quote remaining approximately ${Math.max(0, Math.ceil(((result?.expiresAt ?? quote.expiresAt) - now) / 1000))} seconds` : "Quote expired, updating" : "Auto-calculate after selecting position and asset, entering amount"}</p>{quote && <><p className="mt-2 text-xs leading-5 text-smoke/70">Resale ratio uses the conservative swap outputs (position deposit plus the price-tolerance reserve left in your wallet), estimates immediate swap back to original input asset; not actual sale, also does not represent dollar value.</p><div className="mt-7 space-y-4 text-sm"><Row title="Input limit" value={quote ? `${money(quote.requested, quote.inputDecimals)} ${inputLabel}` : "—"} /><div className="border-t border-white/10" /><Row title={`Swap to ${state ? poolLabel(state.mintA) : "Pool A"} · minOut`} value={quote ? quote.spendA === "0" ? "no swap needed" : money(quote.minOutA, quote.decimalsA) : "—"} /><Row title={`Swap to ${state ? poolLabel(state.mintB) : "Pool B"} · minOut`} value={quote ? quote.spendB === "0" ? "no swap needed" : money(quote.minOutB, quote.decimalsB) : "—"} /><Row title="Estimated new liquidity" value={quote?.liquidity || "—"} /><div className="border-t border-white/10" /><Row title="Estimated immediate resale" value={quote ? `${money(quote.resaleInput, quote.inputDecimals)} ${inputLabel}` : "—"} emphasize /><Row title="Your minimum resale setting" value={quote ? `${money(quote.minimumResaleInput, quote.inputDecimals)} ${inputLabel}` : "—"} /><Row title="Estimated round-trip difference" value={quote ? `${money(quote.roundtripCostInput, quote.inputDecimals)} ${inputLabel}` : "—"} /><Row title="Jupiter transaction slippage" value="0.5%(fixed)" /><Row title="Simulated SOL total debit" value={result?.simulatedSolDebitLamports ? `${money(result.simulatedSolDebitLamports, 9, 9)} SOL(including input and possible rent)` : "Awaiting full simulation"} /></div><p className={`mt-6 rounded-2xl border p-3 text-xs leading-5 ${quote && !quote.passesFloor ? "border-white/20 bg-white/[0.04] text-smoke" : "border-white/10 bg-white/[0.03] text-smoke"}`}>{quote ? quote.passesFloor ? `This estimate meets ${(quote.floorBps / 100).toFixed(1)}% resale ratio threshold.` : (quote.warning || `This estimate is below ${(quote.floorBps / 100).toFixed(1)}% threshold.`) : `Current threshold: estimated immediate swap back to input asset at least ${floorBps === null ? "—" : (floorBps / 100).toFixed(1)}%.`} This value is not a guarantee of execution or future value; SOL fees calculated separately.</p></>}</section>
          {(attempt || result?.simulated || attemptStatus === "manual-review") && <section className="rounded-[28px] border border-white/12 bg-char p-5"><h2 className="font-semibold text-cream">Deposit transaction</h2><p role="status" className="mt-2 text-xs leading-5 text-smoke">{status}</p>{attempt && <p className="mt-3 text-xs text-cream/80"><a href={`https://solscan.io/tx/${attempt.signature}`} target="_blank" rel="noreferrer" className="underline">View transaction {short(attempt.signature)}</a> · NFT {short(attempt.selection.positionMint)}</p>}{attemptStatus === "manual-review" && attempt && <button type="button" className="mt-3 text-xs text-cream/80 underline" onClick={retryReconcile}>Re-verify new version transaction</button>}</section>}
          {visibleAttempt && <button type="button" onClick={() => setStatusDialogOpen(true)}
            className="w-full rounded-full bg-lemon px-5 py-3 text-sm font-semibold text-ink transition-colors hover:bg-[#fff27f]/80 transition-colors hover:bg-white/[0.04]">View transaction status and tx hash</button>}
        </aside>
        </div>
        </div>
      </main>
      {connectionError && activeView === "compound" && <div role="alert" className="mt-4 rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-sm text-cream/80">{connectionError}</div>}
      {error && !quoteError && activeView === "compound" && <div role="alert" className="mt-4 rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-sm text-cream/80">{error}</div>}
    </div>
    <TransactionStatusDialog attempt={visibleAttempt} status={attemptStatus} error={error} open={statusDialogOpen}
      onOpenChange={setStatusDialogOpen} onRetry={retryReconcile} />
    {activeView === "deposit" && <div className="fixed inset-x-0 bottom-0 z-10 border-t border-white/12 bg-canvas/95 p-4 backdrop-blur sm:hidden"><button className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-lemon px-5 py-4 text-sm font-semibold text-ink transition-colors hover:bg-[#fff27f] disabled:cursor-not-allowed disabled:opacity-40" disabled={actionDisabled} onClick={primaryAction}>{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ArrowDown className="h-4 w-4" />}{connected ? actionLabel : "Connect wallet"}</button></div>}
  </div>;
}

function Row({ title, value, emphasize = false }: { title: string; value: string; emphasize?: boolean }) {
  return <div className="flex items-start justify-between gap-4"><span className="text-smoke">{title}</span><span className={`max-w-[55%] text-right font-medium tabular-nums ${emphasize ? "text-cream" : "text-cream/80"}`}>{value}</span></div>;
}

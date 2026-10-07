"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUpRight, CircleAlert, LoaderCircle, Sprout, Wallet } from "lucide-react";
import { Button } from "./ui/button";
import { assetMetadata, assetSymbol, TokenPicker } from "./token-picker";
import { formatAmount } from "@/lib/amount";
import { NATIVE_SOL_MINT, USDC_MINT } from "@/lib/ids";
import type { TokenMetadata } from "@/lib/token-metadata";
import { useSelectedController } from "./use-selected-controller";
import { TransactionStatusDialog } from "./transaction-status-dialog";
import { CompoundPanel } from "./compound-panel";
import { useCompoundController } from "./use-compound-controller";

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

export function SelectedApp() {
  const controller = useSelectedController();
  const { wallet, connected, connect, disconnect, isMobile, walletsCount, connectionError,
    discovery, selection, state, amount, maxCostPercent, tolerancePercent, result, attempt, attemptStatus,
    obsoletePending, error, quoteError, busy: addBusy, calculating, now, floorBps, quote, fresh, status,
    actionLabel, actionDisabled: addDisabled, primaryAction: addAction, changeAmount, changeMaxCost, changeTolerance, fillMax,
    choosePosition, chooseAsset, refreshDiscovery, refreshState, retryCalculation, retryReconcile, retryObsoleteReconcile, clearObsoleteRecords,
    clearInvalidAttempt } = controller;
  const compound = useCompoundController({ wallet: wallet || undefined, positionMint: selection?.positionMint,
    externalBlocked: controller.walletBlocked,
    onConfirmed: () => { void refreshState(); } });
  const busy = addBusy || compound.busy;
  const actionDisabled = addDisabled || compound.walletBlocked;
  const primaryAction = () => { if (!compound.walletBlocked) addAction(); };
  const mintQuery = discovery?.assets.map((asset) => asset.mint).join(",") || "";
  const [metadataState, setMetadataState] = useState<{ query: string; tokens: Record<string, TokenMetadata> }>({ query: "", tokens: {} });
  const [statusDialogOpen, setStatusDialogOpen] = useState(false);
  const [activeView, setActiveView] = useState<"compound" | "deposit">("compound");
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
  useEffect(() => {
    if (!mintQuery) return;
    const aborter = new AbortController();
    const load = async () => {
      const tokens: Record<string, TokenMetadata> = {};
      const mints = mintQuery.split(",");
      for (let index = 0; index < mints.length; index += 100) {
        const response = await fetch("/api/token-metadata", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mints: mints.slice(index, index + 100) }), signal: aborter.signal });
        if (response.ok) Object.assign(tokens, (await response.json() as { tokens: Record<string, TokenMetadata> }).tokens);
      }
      if (!aborter.signal.aborted) setMetadataState({ query: mintQuery, tokens });
    };
    void load().catch(() => undefined); // Mint metadata is optional; on-chain balances remain usable.
    return () => aborter.abort();
  }, [mintQuery]);
  const metadata = metadataState.query === mintQuery ? metadataState.tokens : {};
  const selectedAsset = discovery?.assets.find((asset) => asset.kind === selection?.inputKind && asset.mint === selection?.inputMint);
  const inputLabel = selectedAsset ? assetSymbol(selectedAsset, assetMetadata(selectedAsset, metadata)) : "Input asset";
  const positionOptions = discovery?.positions || [];
  const assetOptions = discovery?.assets || [];
  const poolLabel = (mint: string) => {
    const asset = assetOptions.find((item) => item.mint === mint);
    return asset ? assetSymbol(asset, assetMetadata(asset, metadata)) : tokenLabel(mint);
  };
  return <div className="min-h-screen bg-[#07101d] text-slate-100">
    <div className="pointer-events-none absolute inset-x-0 top-0 h-[500px] bg-[radial-gradient(ellipse_at_top,rgba(40,91,153,0.25),transparent_60%)]" />
    <div className="relative mx-auto max-w-5xl px-5 pb-32 pt-6 sm:px-8 sm:pt-10">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl border border-sky-400/40 bg-sky-400/10 text-lg font-bold text-sky-300">S</div><div><div className="text-sm font-bold tracking-wide">SoFinance</div><div className="text-xs text-slate-400">Solana · Raydium CLMM</div></div></div>
        <div className="flex items-center gap-2">
          <a href="/rwa-pairs" className="rounded-xl border border-slate-600 bg-slate-800/80 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700">RWA pairs</a>
          {connected && wallet ? <Button variant="secondary" className="max-w-[160px] px-3 py-2" onClick={disconnect}><Wallet className="h-4 w-4" />{short(wallet)}</Button>
            : <Button variant="secondary" className="px-3 py-2" onClick={connect}><Wallet className="h-4 w-4" />Connect wallet</Button>}
        </div>
      </header>

      <div className="mb-6 mt-8 sm:mt-10"><h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Manage my liquidity positions</h1><p className="mt-2 text-sm text-slate-400">Add yield back to original position, or invest new capital.</p></div>

      <section aria-labelledby="position-heading" className="rounded-2xl border border-white/10 bg-[#111d2c]/95 p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3"><h2 id="position-heading" className="text-sm font-semibold">My positions</h2><button type="button" disabled={!wallet || busy} onClick={() => void refreshDiscovery()} className="text-xs font-semibold text-sky-300 disabled:opacity-45">Rescan wallet</button></div>
        <label htmlFor="position" className="sr-only">Select Raydium position</label>
        <select id="position" value={selection?.positionMint || ""} disabled={!positionOptions.length || busy} onChange={(event) => choosePosition(event.target.value)} className="mt-3 w-full rounded-xl border border-slate-600 bg-[#0b1523] px-3 py-3 text-sm text-slate-100 outline-none focus:border-sky-400">
          {!positionOptions.length && <option value="">{connected ? "No identifiable position found" : "Connect wallet to view positions"}</option>}
          {positionOptions.map((item) => <option key={item.positionMint} value={item.positionMint}>{poolLabel(item.mintA)} / {poolLabel(item.mintB)} · NFT {short(item.positionMint)} · ticks {item.tickLower}–{item.tickUpper}</option>)}
        </select>
        {state && <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs">
          <span className={`rounded-full px-2.5 py-1 ${state.inRange ? "bg-emerald-400/10 text-emerald-300" : "bg-amber-400/10 text-amber-300"}`}>{state.rangeSide === "above" ? "Above range · single-sided" : state.rangeSide === "below" ? "Below range · single-sided" : "Price within range"}</span>
          <span className="text-slate-400">Position assets: {money(state.currentAmounts.a, state.decimalsA)} {poolLabel(state.mintA)}  +  {money(state.currentAmounts.b, state.decimalsB)} {poolLabel(state.mintB)}</span>
        </div>}
      </section>

      <nav aria-label="Position operations" className="mt-6 flex gap-2 rounded-2xl border border-white/10 bg-[#0b1523] p-1.5">
        <button type="button" aria-pressed={activeView === "compound"} aria-controls="compound-view" onClick={() => setActiveView("compound")} className={`flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-emerald-300 ${activeView === "compound" ? "bg-emerald-400/15 text-emerald-200" : "text-slate-400 hover:text-slate-100"}`}><Sprout className="h-4 w-4" />Yield Compound</button>
        <button type="button" aria-pressed={activeView === "deposit"} aria-controls="deposit-view" onClick={() => setActiveView("deposit")} className={`flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-sky-300 ${activeView === "deposit" ? "bg-sky-400/15 text-sky-200" : "text-slate-400 hover:text-slate-100"}`}><ArrowDown className="h-4 w-4" />Deposit funds</button>
      </nav>
      {controller.walletBlocked && activeView === "compound" && <div role="status" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-400/25 bg-amber-400/10 p-3 text-xs text-amber-200"><span>Deposit transaction pending verification, new transactions paused.</span><button type="button" className="font-semibold underline" onClick={() => { setActiveView("deposit"); if (visibleAttempt) setStatusDialogOpen(true); }}>View deposit transaction</button></div>}
      {compound.walletBlocked && activeView === "deposit" && <div role="status" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-400/25 bg-amber-400/10 p-3 text-xs text-amber-200"><span>Compound or yield recovery transaction pending verification, new transactions paused.</span><button type="button" className="font-semibold underline" onClick={() => setActiveView("compound")}>View compound status</button></div>}
      <main>
        <div id="compound-view" hidden={activeView !== "compound"}>
          <CompoundPanel controller={compound} tokenLabel={poolLabel} />
        </div>
        <div id="deposit-view" hidden={activeView !== "deposit"}>
        <div className="mt-5 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)]">
        <section className="min-w-0 rounded-3xl border border-white/10 bg-[#111d2c]/95 p-5 shadow-2xl shadow-black/20 sm:p-8">
          <h2 className="text-lg font-semibold">Deposit funds</h2><p className="mt-2 text-xs leading-5 text-slate-400">Select wallet assets, swap and add to position selected above.</p>
          <span id="asset-label" className="mt-6 block text-xs font-medium uppercase tracking-[0.16em] text-slate-400">From wallet deposit</span>
          <TokenPicker assets={assetOptions} selectedAsset={selectedAsset} metadata={metadata} disabled={!assetOptions.length || busy} onSelect={chooseAsset} inputPriceUsd={state?.pricing?.priceUsdInput} />
          {selectedAsset && <details className="mt-2 text-[11px] leading-5 text-slate-500"><summary className="cursor-pointer">Asset address and balance source</summary><p className="mt-2 break-all">Mint {selectedAsset.mint} · Available for input ATA/SOL balance {money(selectedAsset.balance, selectedAsset.decimals, selectedAsset.decimals)}{selectedAsset.totalBalance !== selectedAsset.balance ? `; wallet total holdings ${money(selectedAsset.totalBalance, selectedAsset.decimals, selectedAsset.decimals)}` : ""}</p></details>}
          <label htmlFor="amount" className="mt-7 block text-xs font-medium uppercase tracking-[0.16em] text-slate-400">Input limit</label>
          <div className="mt-2 flex items-center gap-2 rounded-2xl border border-slate-600/70 bg-[#0b1523] px-4 py-3 focus-within:border-sky-400"><input id="amount" disabled={busy || !selection} inputMode="decimal" placeholder="Enter amount" value={amount} onChange={(event) => changeAmount(event.target.value)} className="min-w-0 flex-1 bg-transparent text-3xl font-semibold outline-none placeholder:text-slate-600" /><span className="text-sm font-semibold text-slate-300">{inputLabel}</span></div>
          {state?.pricing?.priceUsdInput !== undefined && state.pricing.priceUsdInput !== null && amount && (() => {
            const inputUsd = calculateInputUsd(amount, state.pricing.priceUsdInput);
            return inputUsd ? <div className="mt-2 text-center text-sm text-slate-500">{inputUsd}</div> : null;
          })()}
          <div className="mt-3 flex items-center justify-between text-xs text-slate-400"><span>Available for input balance: {state ? `${money(state.inputBalance, state.inputDecimals, state.inputDecimals)} ${inputLabel}` : "—"}</span><button type="button" className="font-semibold text-sky-300 hover:text-sky-200 disabled:opacity-45" onClick={fillMax} disabled={busy || !state}>MAX</button></div>
          <details className="mt-5 text-xs text-slate-400"><summary className="cursor-pointer font-semibold">Advanced settings · Max resale difference {maxCostPercent}% · Price tolerance {tolerancePercent}%</summary>
          <div className="mt-3 flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-[#0b1523] px-4 py-3"><div><label htmlFor="max-cost" className="text-sm font-medium">Maximum estimated immediate resale difference</label><p className="mt-1 text-xs leading-5 text-slate-400">Estimated ratio to swap back to same input asset; can set 0–5%, by 0.1%. Transaction slippage fixed at 0.5%.</p></div><div className="flex shrink-0 items-center gap-1"><input id="max-cost" disabled={busy} type="number" inputMode="decimal" min="0" max="5" step="0.1" value={maxCostPercent} onChange={(event) => changeMaxCost(event.target.value)} className="w-16 rounded-lg border border-slate-600 bg-[#111d2c] px-2 py-1.5 text-right text-sm font-semibold outline-none focus:border-sky-400" /><span className="text-sm text-slate-300">%</span></div></div>
          <div className="mt-3 flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-[#0b1523] px-4 py-3"><div><label htmlFor="tolerance" className="text-sm font-medium">Add-liquidity price tolerance</label><p className="mt-1 text-xs leading-5 text-slate-400">Room for the pool price to move before execution; 0–5%, by 0.1%. The unused reserve stays in your wallet as pool assets.</p></div><div className="flex shrink-0 items-center gap-1"><input id="tolerance" disabled={busy} type="number" inputMode="decimal" min="0" max="5" step="0.1" value={tolerancePercent} onChange={(event) => changeTolerance(event.target.value)} className="w-16 rounded-lg border border-slate-600 bg-[#111d2c] px-2 py-1.5 text-right text-sm font-semibold outline-none focus:border-sky-400" /><span className="text-sm text-slate-300">%</span></div></div>
          </details>
          <p className="mt-5 text-xs leading-5 text-slate-400">Auto-calculated after entering amount; will re-simulate with latest quote before signing, and confirmed by wallet.</p>
          <div className="mt-6 hidden sm:block"><Button className="w-full py-4" disabled={actionDisabled} onClick={primaryAction}>{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ArrowDown className="h-4 w-4" />}{actionLabel}</Button></div>
          <div role="status" className="mt-3 min-h-5 text-xs text-slate-400">{status}</div>
          {attemptStatus === "manual-review" && !attempt && <button type="button" className="mt-2 text-xs text-sky-300 underline" onClick={clearInvalidAttempt}>Clear invalid new version records after self-verification on-chain</button>}
          {obsoletePending && <button type="button" className="mt-2 text-xs text-sky-300 underline" onClick={retryObsoleteReconcile}>Re-verify previous version transaction</button>}
          {obsoletePending && <button type="button" className="ml-4 mt-2 text-xs text-amber-300 underline" onClick={clearObsoleteRecords}>Clear previous version records after self-verification on-chain</button>}
          {!connected && isMobile && <p className="mt-2 text-xs leading-5 text-sky-200/80">Using mobile Jupiter Wallet: scan QR Code after clicking &quot;Connect wallet&quot;.</p>}
          {!connected && !isMobile && <p className="mt-2 text-xs leading-5 text-amber-200/80">Mobile Jupiter Wallet QR code connection requires Reown Project ID setup first.{walletsCount === 0 ? "This browser has not detected wallet extensions." : ""}</p>}
          {connectionError && <div role="alert" className="mt-4 flex gap-2 rounded-xl border border-amber-400/25 bg-amber-400/10 p-3 text-sm text-amber-200"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />{connectionError}</div>}
          {error && <div role="alert" className="mt-4 flex gap-2 rounded-xl border border-rose-400/25 bg-rose-400/10 p-3 text-sm text-rose-200"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /><span className="flex-1">{error}</span>{quoteError && <button type="button" onClick={retryCalculation} className="shrink-0 font-semibold underline">Recalculate</button>}</div>}
        </section>

        <aside className="min-w-0 space-y-6"><section className="rounded-3xl border border-white/10 bg-[#111d2c]/95 p-5 sm:p-7"><h2 className="text-lg font-semibold">Deposit preview</h2><p className="mt-2 text-xs leading-5 text-slate-400">{calculating ? <span role="status" className="inline-flex items-center gap-2 text-sky-300"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Calculating deposit estimates and transaction checks…</span> : quote ? fresh ? `Quote remaining approximately ${Math.max(0, Math.ceil(((result?.expiresAt ?? quote.expiresAt) - now) / 1000))} seconds` : "Quote expired, updating" : "Auto-calculate after selecting position and asset, entering amount"}</p>{quote && <><p className="mt-2 text-xs leading-5 text-slate-500">Resale ratio uses the conservative swap outputs (position deposit plus the price-tolerance reserve left in your wallet), estimates immediate swap back to original input asset; not actual sale, also does not represent dollar value.</p><div className="mt-7 space-y-4 text-sm"><Row title="Input limit" value={quote ? `${money(quote.requested, quote.inputDecimals)} ${inputLabel}` : "—"} /><div className="border-t border-white/10" /><Row title={`Swap to ${state ? poolLabel(state.mintA) : "Pool A"} · minOut`} value={quote ? quote.spendA === "0" ? "no swap needed" : money(quote.minOutA, quote.decimalsA) : "—"} /><Row title={`Swap to ${state ? poolLabel(state.mintB) : "Pool B"} · minOut`} value={quote ? quote.spendB === "0" ? "no swap needed" : money(quote.minOutB, quote.decimalsB) : "—"} /><Row title="Estimated new liquidity" value={quote?.liquidity || "—"} /><div className="border-t border-white/10" /><Row title="Estimated immediate resale" value={quote ? `${money(quote.resaleInput, quote.inputDecimals)} ${inputLabel}` : "—"} emphasize /><Row title="Your minimum resale setting" value={quote ? `${money(quote.minimumResaleInput, quote.inputDecimals)} ${inputLabel}` : "—"} /><Row title="Estimated round-trip difference" value={quote ? `${money(quote.roundtripCostInput, quote.inputDecimals)} ${inputLabel}` : "—"} /><Row title="Jupiter transaction slippage" value="0.5%(fixed)" /><Row title="Simulated SOL total debit" value={result?.simulatedSolDebitLamports ? `${money(result.simulatedSolDebitLamports, 9, 9)} SOL(including input and possible rent)` : "Awaiting full simulation"} /></div><p className={`mt-6 rounded-xl p-3 text-xs leading-5 ${quote && !quote.passesFloor ? "bg-rose-400/10 text-rose-200" : "bg-white/[0.04] text-slate-400"}`}>{quote ? quote.passesFloor ? `This estimate meets ${(quote.floorBps / 100).toFixed(1)}% resale ratio threshold.` : `This estimate is below ${(quote.floorBps / 100).toFixed(1)}% threshold.` : `Current threshold: estimated immediate swap back to input asset at least ${floorBps === null ? "—" : (floorBps / 100).toFixed(1)}%.`} This value is not a guarantee of execution or future value; SOL fees calculated separately.</p></>}</section>
          {(attempt || result?.simulated || attemptStatus === "manual-review") && <section className="rounded-2xl border border-white/10 bg-[#111d2c]/95 p-5"><h2 className="font-semibold">Deposit transaction</h2><p role="status" className="mt-2 text-xs leading-5 text-slate-400">{status}</p>{attempt && <p className="mt-3 text-xs text-sky-300"><a href={`https://solscan.io/tx/${attempt.signature}`} target="_blank" rel="noreferrer" className="underline">View transaction {short(attempt.signature)}</a> · NFT {short(attempt.selection.positionMint)}</p>}{attemptStatus === "manual-review" && attempt && <button type="button" className="mt-3 text-xs text-sky-300 underline" onClick={retryReconcile}>Re-verify new version transaction</button>}</section>}
          {visibleAttempt && <button type="button" onClick={() => setStatusDialogOpen(true)}
            className="w-full rounded-xl border border-sky-400/30 px-4 py-3 text-sm font-semibold text-sky-300 hover:bg-sky-400/10">View transaction status and tx hash</button>}
        </aside>
        </div>
        </div>
      </main>
      {connectionError && activeView === "compound" && <div role="alert" className="mt-4 rounded-xl border border-amber-400/25 bg-amber-400/10 p-3 text-sm text-amber-200">{connectionError}</div>}
      {error && !quoteError && activeView === "compound" && <div role="alert" className="mt-4 rounded-xl border border-rose-400/25 bg-rose-400/10 p-3 text-sm text-rose-200">{error}</div>}
      {!connected && <p className="mt-4 text-xs leading-5 text-slate-400">{isMobile ? "Using mobile Jupiter Wallet: scan QR Code after clicking &quot;Connect wallet&quot;." : walletsCount === 0 ? "Wallet extensions not detected; mobile wallets can scan QR via Connect wallet." : "After Connect wallet, will auto-read your Raydium CLMM positions."}</p>}
      <details className="mt-8 rounded-2xl border border-white/10 px-5 py-4 text-xs text-slate-400"><summary className="cursor-pointer font-semibold text-slate-300">Detailed information and asset risks</summary><div className="mt-4 space-y-2 break-all leading-5">{state && <><p>Real-time pool price: {Number(state.price).toPrecision(8)} · ticks {state.tickLower}–{state.tickUpper} · slot {state.slot}</p><p>Wallet pool asset balance: {money(state.balances.a, state.decimalsA)} {poolLabel(state.mintA)}  +  {money(state.balances.b, state.decimalsB)} {poolLabel(state.mintB)} · SOL {money(String(state.solLamports), 9)}</p><button type="button" onClick={() => void refreshState()} disabled={busy} className="text-sky-300 disabled:opacity-45">Reload on-chain</button><p>Pool: <a className="text-sky-300" href={`https://solscan.io/account/${state.poolId}`} target="_blank" rel="noreferrer">{state.poolId} <ArrowUpRight className="inline h-3 w-3" /></a></p><p>Position NFT: {state.positionMint}</p><p>Pool A mint: {state.mintA}</p><p>Pool B mint: {state.mintB}</p><p>Input mint: {selection?.inputMint}</p></>}<p>Different tokens may have issuer, transfer restrictions, or routing liquidity risks. APR does not represent this position&apos;s realizable returns; no trading fees earned for this range while outside.</p></div></details>
    </div>
    <TransactionStatusDialog attempt={visibleAttempt} status={attemptStatus} error={error} open={statusDialogOpen}
      onOpenChange={setStatusDialogOpen} onRetry={retryReconcile} />
    {activeView === "deposit" && <div className="fixed inset-x-0 bottom-0 z-10 border-t border-white/10 bg-[#07101d]/95 p-4 backdrop-blur sm:hidden"><Button className="w-full py-4" disabled={actionDisabled} onClick={primaryAction}>{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ArrowDown className="h-4 w-4" />}{actionLabel}</Button></div>}
  </div>;
}

function Row({ title, value, emphasize = false }: { title: string; value: string; emphasize?: boolean }) {
  return <div className="flex items-start justify-between gap-4"><span className="text-slate-400">{title}</span><span className={`max-w-[55%] text-right font-medium tabular-nums ${emphasize ? "text-sky-300" : "text-slate-100"}`}>{value}</span></div>;
}

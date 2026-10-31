"use client";
import "@/lib/engine-host";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpRight, ChartNoAxesCombined, CircleAlert, LoaderCircle, Sprout } from "lucide-react";
import { assetMetadata, assetSymbol, TokenPicker } from "./token-picker";
import { formatAmount } from "@sofinance/engine/amount";
import { NATIVE_SOL_MINT, USDC_MINT } from "@sofinance/engine/ids";
import { PositionSelect } from "./position-select";
import { PositionAssetRow } from "./position-asset-row";
import { resolveNftAccountLookup } from "@/lib/exit-account-lookup";
import { useTokenMetadata } from "./use-token-metadata";
import { useSelectedController } from "./use-selected-controller";
import { TransactionStatusDialog } from "./transaction-status-dialog";
import { CompoundPanel } from "./compound-panel";
import { useCompoundController } from "./use-compound-controller";
import { InkHero, InkNav } from "./ink";
import { PositionPerformancePanel } from "./position-performance-panel";
import { ConnectWalletPrompt } from "./connect-wallet-prompt";
import { WithdrawPanel } from "./withdraw-panel";
import { ActionSelector } from "./action-selector";
import { AssetRisksDialog } from "./asset-risks-dialog";
import { APP_ROUTES, DOCS_ROUTES } from "@/lib/public-urls";
import { formatSelectedNoRouteMessage, JUPITER_NO_ROUTE_CODE } from "@/lib/selected-no-route";
import Link from "next/link";
import { captureGrowthEvent } from "@/lib/analytics/client";
import { GROWTH_EVENTS } from "@/lib/analytics/events";

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

export function SelectedApp({ initialView = "compound", initialMint = "", initialWallet = "", previewPoolId = "", extraPositions, onRescan }: {
  initialView?: "compound" | "performance" | "deposit" | "withdraw";
  initialMint?: string;
  initialWallet?: string;
  previewPoolId?: string;
  /** Other chains' positions, shown under the Solana ones in "My positions" (`/app`: Robinhood Chain). */
  extraPositions?: ReactNode;
  /** Called by "Rescan wallet" alongside the Solana rescan, so the other chains' positions in "My positions" rescan too. */
  onRescan?: () => void;
} = {}) {
  const [withdrawBusy,setWithdrawBusy]=useState(false);
  const controller = useSelectedController();
  const { wallet, connected, connect, disconnect, connectionError,
    discovery, selection, state, amount, tolerancePercent, result, attempt, attemptStatus,
    error, reprepare, quoteError, quoteErrorCode, quoteErrorOutputMint, showQuoteRecalculate,
    busy: addBusy, retryAdd, calculating, now, quote, fresh, status,
    actionLabel, actionDisabled: addDisabled, primaryAction: addAction, changeAmount, changeTolerance, fillMax,
    choosePosition, chooseAsset, refreshDiscovery, refreshState, retryCalculation,
    loadingDiscovery, loadingState, stateError } = controller;
  const totalCostPercent = quote && typeof quote.roundtripCostInput === "string" && BigInt(quote.requested) > 0n
    ? (Number(quote.roundtripCostInput) / Number(quote.requested) * 100).toFixed(2)
    : null;
  const compound = useCompoundController({ wallet: wallet || undefined, positionMint: selection?.positionMint,
    externalBlocked: addBusy || withdrawBusy,
    onConfirmed: () => { void refreshState(); } });
  // Unclaimed fees come from the compound reader (same accrual formula as the Performance card); its snapshot also carries the
  // liquidity amounts, so rows show liquidity and unclaimed fees from one consistent read when it is available.
  const feeState = state && compound.state?.positionMint === state.positionMint ? compound.state : null;
  const assets = feeState ?? state;
  const busy = addBusy || compound.busy || withdrawBusy;
  const actionDisabled = connected && (addDisabled || compound.busy || withdrawBusy);
  const actionLoading = connected && (busy || calculating);
  const buttonLabel = !connected ? "Connect wallet" : compound.busy ? "Another operation in progress…" :
    calculating ? "Estimating liquidity…" : actionLabel;
  const buttonClass = `inline-flex w-full items-center justify-center gap-2 rounded-full bg-lemon px-5 py-4 text-sm font-semibold text-ink transition-colors hover:bg-[#fff27f] ${actionLoading ? "cursor-wait disabled:opacity-100" : "disabled:cursor-not-allowed disabled:opacity-40"}`;
  const addStatus = compound.busy ? "A compound or recovery operation is in progress." : status;
  const primaryAction = () => { if (!connected) { connect(); return; } if (!compound.busy) addAction(); };
  const metadataMints = [
    ...(discovery?.assets.map((asset) => asset.mint) || []),
    ...(discovery?.positions.flatMap((item) => [item.mintA, item.mintB]) || []),
    ...(state ? [state.mintA, state.mintB] : []),
  ];
  const metadata = useTokenMetadata(metadataMints);
  const [statusDialogOpen, setStatusDialogOpen] = useState(false);
  const [assetRisksOpen, setAssetRisksOpen] = useState(false);
  const [activeView, setActiveView] = useState<"compound" | "performance" | "deposit" | "withdraw">(initialView);
  // Performance is a tab inside /app (the URL does not change), so $pageview cannot see it.
  useEffect(() => {
    if (activeView === "performance") captureGrowthEvent(GROWTH_EVENTS.performanceView);
  }, [activeView]);
  // A deep link (?mint=) wins over the wallet's default selection until the user picks a position themselves. It is applied
  // once per wallet (the controller resets the selection whenever the wallet changes).
  const linkedPositionWallet = useRef("");
  const [pickedPosition, setPickedPosition] = useState(false);
  useEffect(() => {
    if (!wallet || linkedPositionWallet.current === wallet || !initialMint || !discovery) return;
    if (discovery.positions.some((position) => position.positionMint === initialMint)) {
      linkedPositionWallet.current = wallet;
      choosePosition(initialMint);
    }
  }, [initialMint, discovery, wallet, choosePosition]);
  const pickPosition = (positionMint: string) => { setPickedPosition(true); choosePosition(positionMint); };
  const linkActive = Boolean(initialMint) && !pickedPosition;
  const performanceMint = linkActive ? initialMint : selection?.positionMint || initialMint;
  const nftAccountLookup = resolveNftAccountLookup({ connected, targetMint: performanceMint, discovery, state,
    loadingDiscovery, loadingState, hasError: Boolean(stateError) });
  const linkedForeignPosition = linkActive && connected && discovery !== null && !loadingDiscovery
    && !discovery.positions.some((position) => position.positionMint === initialMint);
  const visibleAttempt = attempt?.wallet === wallet ? attempt : null;
  useEffect(() => {
    const timer = window.setTimeout(() => setStatusDialogOpen(false), 0);
    return () => window.clearTimeout(timer);
  }, [wallet]);
  const selectedAsset = discovery?.assets.find((asset) => asset.kind === selection?.inputKind && asset.mint === selection?.inputMint);
  const inputLabel = selectedAsset ? assetSymbol(selectedAsset, assetMetadata(selectedAsset, metadata)) : "Input asset";
  const positionOptions = discovery?.positions || [];
  const assetOptions = discovery?.assets || [];
  const poolLabel = (mint: string) => {
    const asset = assetOptions.find((item) => item.mint === mint);
    return asset ? assetSymbol(asset, assetMetadata(asset, metadata)) : metadata[mint]?.symbol || tokenLabel(mint);
  };
  const noRouteOutput = quoteErrorOutputMint || state?.mintA || "";
  const displayError = quoteErrorCode === JUPITER_NO_ROUTE_CODE && noRouteOutput
    ? formatSelectedNoRouteMessage(inputLabel, poolLabel(noRouteOutput))
    : error;
  // "Rescan wallet": the Solana scan (unchanged) plus, on /app, the Robinhood Chain scan via the parent's refresh counter.
  const rescan = () => { if (wallet) void refreshDiscovery(); onRescan?.(); };
  return <div className="min-h-screen bg-canvas text-cream">
    <div className="relative mx-auto max-w-[1280px] px-3 pb-32 pt-3 sm:px-5 sm:pt-5">
      <InkNav wallet={wallet} connected={connected} onConnect={connect} onDisconnect={disconnect} />

      <div className="mt-3 grid gap-3 lg:grid-cols-12">
      <InkHero stacked className="mt-0 border border-transparent lg:col-span-7" label="Positions" title="Manage my liquidity positions">Add yield back to original position, or invest new capital.</InkHero>

      <section aria-labelledby="position-heading" className="flex flex-col rounded-[28px] border border-white/12 bg-char p-6 sm:p-9 lg:col-span-5">
        <div className="flex flex-1 flex-col justify-center">
        <div className="flex items-center justify-between gap-3"><h2 id="position-heading" className="text-base font-semibold text-cream">My positions</h2><button type="button" disabled={(!wallet && !(extraPositions && onRescan)) || busy} onClick={rescan} className="text-xs font-semibold text-cream/80 transition-opacity hover:opacity-70 disabled:opacity-40">Rescan wallet</button></div>
        {extraPositions && <p className="mt-3 text-sm font-semibold text-cream">Solana</p>}
        {connected ? <PositionSelect
          id="position"
          label="Select Raydium position"
          labelSrOnly
          value={selection?.positionMint || ""}
          disabled={!positionOptions.length || busy}
          onChange={pickPosition}
          positions={positionOptions}
          metadata={metadata}
          placeholder={!positionOptions.length ? (connected ? "No identifiable position found" : "Connect wallet to view positions") : undefined}
          className="mt-3 w-full rounded-2xl border border-white/20 bg-white/[0.06] px-3 py-3 text-sm text-cream outline-none focus:border-white/40"
        /> : <div className="mt-3"><ConnectWalletPrompt onConnect={connect} /></div>}
        {connected && discovery && positionOptions.length === 0 && <a href={APP_ROUTES.rwaPairs} className="mt-3 text-sm font-semibold text-cream underline underline-offset-4">Explore pools to open a position</a>}
        {state && <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs">
          <span className={`rounded-full border px-2.5 py-1 ${state.inRange ? "border-white/40 bg-white/[0.07] text-cream/80" : "border-white/20 bg-white/[0.05] text-smoke"}`}>{state.rangeSide === "above" ? "Above range · single-sided" : state.rangeSide === "below" ? "Below range · single-sided" : "Price within range"}</span>

        </div>}
        {assets && <div aria-label="Position assets" className="mt-5 divide-y divide-white/10">
          <PositionAssetRow symbol={poolLabel(assets.mintA)} icon={metadata[assets.mintA]?.icon ?? null} decimals={assets.decimalsA}
            liquidityRaw={assets.currentAmounts.a} unclaimedFeesRaw={feeState?.fees.a ?? null} priceUsd={assets.pricing?.priceUsdA ?? null} />
          <PositionAssetRow symbol={poolLabel(assets.mintB)} icon={metadata[assets.mintB]?.icon ?? null} decimals={assets.decimalsB}
            liquidityRaw={assets.currentAmounts.b} unclaimedFeesRaw={feeState?.fees.b ?? null} priceUsd={assets.pricing?.priceUsdB ?? null} />
        </div>}
        {extraPositions}
        </div>
        {connected && <div className="mt-6 border-t border-white/10 pt-5 text-sm leading-relaxed">
          <button type="button" aria-haspopup="dialog" onClick={() => setAssetRisksOpen(true)}
            className="text-xs font-semibold text-cream/80 transition-opacity hover:opacity-70 disabled:opacity-40">
            Learn more details
          </button>
        </div>}
      </section>
      </div>

      <ActionSelector value={activeView} onChange={setActiveView} options={[
        { value: "compound", label: "Yield Compound", icon: Sprout, controls: "compound-view" },
        { value: "performance", label: "Performance", icon: ChartNoAxesCombined, controls: "performance-view" },
        { value: "deposit", label: "Add to position", icon: ArrowDown, controls: "deposit-view" },
        { value: "withdraw", label: "Withdraw", icon: ArrowUp, controls: "withdraw-view", disabled: !state || !wallet || (busy && activeView !== "withdraw") },
      ]} />
      {activeView === "withdraw" && <div id="withdraw-view">{state && wallet ? <WithdrawPanel key={`${wallet}:${state.positionMint}`} wallet={wallet} positionMint={state.positionMint} mintA={state.mintA} mintB={state.mintB} label={poolLabel} onClose={()=>setActiveView("compound")} onBusyChange={setWithdrawBusy} onConfirmed={()=>{void refreshState();void refreshDiscovery();}} /> : <p className="mt-4 text-sm text-smoke">Connect your wallet and choose a position to withdraw.</p>}</div>}
      {compound.historyWarning && <div role="status" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-xs text-cream/80"><span>{compound.historyWarning}</span><button type="button" className="font-semibold underline" onClick={() => setActiveView("compound")}>View compound status</button></div>}
      <main>
        <div id="compound-view" hidden={activeView !== "compound"}>
          <CompoundPanel controller={compound} tokenLabel={poolLabel} onConnect={connect} />
        </div>
        <div id="performance-view" hidden={activeView !== "performance"} className="mt-3 space-y-3">
          {activeView === "performance" && linkedForeignPosition && <p role="status" className="rounded-2xl border border-white/15 bg-white/[0.04] px-4 py-3 text-xs leading-5 text-smoke">
            Showing the linked position {initialMint.slice(0, 4)}…{initialMint.slice(-4)}. It is not held by the connected wallet, so only public data is shown.
          </p>}
          {activeView === "performance" && <PositionPerformancePanel embedded selectedMint={performanceMint} selectedNftAccount={nftAccountLookup.account}
            nftAccountPending={nftAccountLookup.pending} initialWallet={initialWallet} previewPoolId={previewPoolId} />}
        </div>
        <div id="deposit-view" hidden={activeView !== "deposit"}>
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)]">
        <section className="min-w-0 rounded-[28px] border border-white/12 bg-char p-5 sm:p-8">
          <h2 className="text-lg font-semibold text-cream">Add to existing position</h2><p className="mt-2 text-xs leading-5 text-smoke">Choose an asset from your wallet. We swap it into the pool tokens as needed, then add liquidity to the existing LP position selected above in one transaction. Your position keeps its current price range.</p>
          <span id="asset-label" className="mt-6 block text-xs font-medium uppercase tracking-[0.16em] text-smoke">Asset to add from wallet</span>
          <TokenPicker assets={assetOptions} selectedAsset={selectedAsset} metadata={metadata} disabled={!assetOptions.length || busy} onSelect={chooseAsset} inputPriceUsd={state?.pricing?.priceUsdInput} />
          {selectedAsset && <details className="mt-2 text-[11px] leading-5 text-smoke/70"><summary className="cursor-pointer">Asset address and balance source</summary><p className="mt-2 break-all">Mint {selectedAsset.mint} · Available for input ATA/SOL balance {money(selectedAsset.balance, selectedAsset.decimals, selectedAsset.decimals)}{selectedAsset.totalBalance !== selectedAsset.balance ? `; wallet total holdings ${money(selectedAsset.totalBalance, selectedAsset.decimals, selectedAsset.decimals)}` : ""}</p></details>}
          <label htmlFor="amount" className="mt-7 block text-xs font-medium uppercase tracking-[0.16em] text-smoke">Input limit</label>
          <div className="mt-2 flex items-center gap-2 rounded-2xl border border-white/20 bg-white/[0.06] px-4 py-3 focus-within:border-white/40"><input id="amount" disabled={busy || !state} inputMode="decimal" placeholder="Enter amount" value={amount} onChange={(event) => changeAmount(event.target.value)} className="min-w-0 flex-1 bg-transparent text-3xl font-semibold text-cream outline-none placeholder:text-smoke/50" /><span className="text-sm font-semibold text-cream/80">{inputLabel}</span></div>
          {state?.pricing?.priceUsdInput !== undefined && state.pricing.priceUsdInput !== null && amount && (() => {
            const inputUsd = calculateInputUsd(amount, state.pricing.priceUsdInput);
            return inputUsd ? <div className="mt-2 text-center text-sm text-smoke/70">{inputUsd}</div> : null;
          })()}
          <div className="mt-3 flex items-center justify-between text-xs text-smoke"><span>Available for input balance: {state ? `${money(state.inputBalance, state.inputDecimals, state.inputDecimals)} ${inputLabel}` : "—"}</span><button type="button" className="font-semibold text-cream/80 hover:text-cream disabled:opacity-40" onClick={fillMax} disabled={busy || !state}>MAX</button></div>
          <details className="mt-5 text-xs text-smoke"><summary className="cursor-pointer font-semibold">Advanced settings · Price tolerance {tolerancePercent}%</summary>
          <div className="mt-3 flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3"><div><label htmlFor="tolerance" className="text-sm font-medium text-cream/80">Add-liquidity price tolerance</label><p className="mt-1 text-xs leading-5 text-smoke">Room for the pool price to move before execution; 0–5%, by 0.1%. The unused reserve stays in your wallet as pool assets.</p></div><div className="flex shrink-0 items-center gap-1"><input id="tolerance" disabled={busy} type="number" inputMode="decimal" min="0" max="5" step="0.1" value={tolerancePercent} onChange={(event) => changeTolerance(event.target.value)} className="w-16 rounded-lg border border-white/20 bg-white/10 px-2 py-1.5 text-right text-sm font-semibold text-cream outline-none focus:border-white/40" /><span className="text-sm text-cream/80">%</span></div></div>
          </details>
          <p className="mt-5 text-xs leading-5 text-smoke">Preview updates after entering an amount. Add liquidity runs the final checks before wallet confirmation.</p>
          <div className="mt-6 hidden sm:block"><button className={buttonClass} disabled={actionDisabled} aria-busy={actionLoading} onClick={primaryAction}>{actionLoading ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <ArrowDown aria-hidden="true" className="h-4 w-4" />}{buttonLabel}</button></div>
          {connected && <div role="status" className="mt-3 min-h-5 text-xs text-smoke">{addStatus}</div>}
          {connectionError && <div role="alert" className="mt-4 flex gap-2 rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-sm text-cream/80"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />{connectionError}</div>}
          {displayError && <div role="alert" className="mt-4 flex gap-2 rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-sm text-cream/80"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /><span className="flex-1">{displayError}</span>{showQuoteRecalculate && <button type="button" onClick={retryCalculation} className="shrink-0 font-semibold underline">Recalculate</button>}{reprepare && !showQuoteRecalculate && <button type="button" onClick={primaryAction} disabled={actionDisabled} data-testid="add-reprepare" className="shrink-0 font-semibold underline disabled:opacity-40">{actionDisabled ? "Getting a fresh quote…" : "Try again"}</button>}</div>}
        </section>

        <aside className="min-w-0 space-y-3"><section className="rounded-[28px] border border-white/12 bg-char p-5 sm:p-7"><h2 className="text-lg font-semibold text-cream">Add liquidity preview</h2><p className="mt-2 text-xs leading-5 text-smoke">{calculating ? <span role="status" className="inline-flex items-center gap-2 text-cream/80"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Estimating liquidity…</span> : quote ? fresh ? `Preview valid for approximately ${Math.max(0, Math.ceil(((result?.expiresAt ?? quote.expiresAt) - now) / 1000))} seconds` : "Preview expired, updating" : "Auto-calculate after selecting position and asset, entering amount"}</p>{quote && <>{totalCostPercent !== null && <p className="mt-2 text-xs leading-5 text-smoke/70">Total cost uses the conservative swap outputs (liquidity added plus the price-tolerance reserve left in your wallet), estimates immediate swap back to original input asset; not actual sale, also does not represent dollar value.</p>}<div className="mt-7 space-y-4 text-sm"><Row title="Input limit" value={quote ? `${money(quote.requested, quote.inputDecimals)} ${inputLabel}` : "—"} />{quote.feeBps > 0 && <Row title={`Protocol fee (${(quote.feeBps / 100).toFixed(2)}%)`} value={`${money(quote.feeAmount, quote.inputDecimals)} ${inputLabel}`} />}<div className="border-t border-white/10" /><Row title={`Swap to ${state ? poolLabel(state.mintA) : "Pool A"} · minOut`} value={quote ? quote.spendA === "0" ? "no swap needed" : money(quote.minOutA, quote.decimalsA) : "—"} /><Row title={`Swap to ${state ? poolLabel(state.mintB) : "Pool B"} · minOut`} value={quote ? quote.spendB === "0" ? "no swap needed" : money(quote.minOutB, quote.decimalsB) : "—"} /><Row title="Estimated liquidity added" value={quote?.liquidity || "—"} /><div className="border-t border-white/10" />{totalCostPercent !== null && <Row title="Total cost" value={`~${totalCostPercent}%`} emphasize />}<Row title="Jupiter transaction slippage" value="0.5%(fixed)" /><Row title="Simulated SOL total debit" value={result?.simulatedSolDebitLamports ? `${money(result.simulatedSolDebitLamports, 9, 9)} SOL(including input and possible rent)` : "Checked when you add liquidity"} /></div>{totalCostPercent !== null && <p className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-xs leading-5 text-smoke">Estimated round-trip cost: about {totalCostPercent ?? "—"}% (assuming you add liquidity, immediately withdraw, and swap back to {inputLabel}). This conservative estimate includes swap fees, price impact, and slippage tolerance. It does not block signing. Network fees and account rent are separate. This value is not a guarantee of execution or future value.</p>}</>}</section>
          {(attempt || result?.simulated) && <section className="rounded-[28px] border border-white/12 bg-char p-5"><h2 className="font-semibold text-cream">Add liquidity transaction</h2><p role="status" className="mt-2 text-xs leading-5 text-smoke">{attemptStatus ? `Transaction status: ${attemptStatus}` : addStatus}</p>{attempt && <p className="mt-3 text-xs text-cream/80"><a href={`https://solscan.io/tx/${attempt.signature}`} target="_blank" rel="noreferrer" className="underline">View transaction {short(attempt.signature)}</a> · NFT {short(attempt.positionMint)}</p>}</section>}
          {visibleAttempt && <button type="button" onClick={() => setStatusDialogOpen(true)}
            className="w-full rounded-full bg-lemon px-5 py-3 text-sm font-semibold text-ink transition-colors hover:bg-[#fff27f]/80 transition-colors hover:bg-white/[0.04]">View transaction status and tx hash</button>}
        </aside>
        </div>
        </div>
      </main>
      {connectionError && activeView === "compound" && <div role="alert" className="mt-4 rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-sm text-cream/80">{connectionError}</div>}
      {error && !quoteError && activeView === "compound" && <div role="alert" className="mt-4 rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-sm text-cream/80">{error}</div>}
    </div>
    <AssetRisksDialog open={connected && assetRisksOpen} onOpenChange={setAssetRisksOpen}>
      {state && <><p>Real-time pool price: {Number(state.price).toPrecision(8)} · ticks {state.tickLower}–{state.tickUpper} · slot {state.slot}</p><p>Wallet pool asset balance: {money(state.balances.a, state.decimalsA)} {poolLabel(state.mintA)}  +  {money(state.balances.b, state.decimalsB)} {poolLabel(state.mintB)} · SOL {money(String(state.solLamports), 9)}</p><button type="button" onClick={() => void refreshState()} disabled={busy} className="text-cream/80 underline disabled:opacity-40">Reload on-chain</button><p>Pool: <a className="text-cream/80 underline" href={`https://solscan.io/account/${state.poolId}`} target="_blank" rel="noreferrer">{state.poolId} <ArrowUpRight className="inline h-3 w-3" /></a></p><p>Position NFT: {state.positionMint}</p><p>Pool A mint: {state.mintA}</p><p>Pool B mint: {state.mintB}</p><p>Input mint: {selection?.inputMint}</p></>}<p>Different tokens may have issuer, transfer restrictions, or routing liquidity risks. APR does not represent this position&apos;s realizable returns; no trading fees earned for this range while outside.</p>
      <p><Link href={DOCS_ROUTES.risks} className="text-lemon underline underline-offset-2 hover:text-[#fff27f]">Read the Risks docs</Link> before adding liquidity.</p>
    </AssetRisksDialog>
    <TransactionStatusDialog attempt={visibleAttempt} status={attemptStatus} error={error} open={statusDialogOpen}
      onOpenChange={setStatusDialogOpen}
      onRetry={retryAdd ? () => { setStatusDialogOpen(false); retryAdd(); } : undefined} />
    {activeView === "deposit" && <div className="fixed inset-x-0 bottom-0 z-10 border-t border-white/12 bg-canvas/95 p-4 backdrop-blur sm:hidden"><button className={buttonClass} disabled={actionDisabled} aria-busy={actionLoading} onClick={primaryAction}>{actionLoading ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <ArrowDown aria-hidden="true" className="h-4 w-4" />}{buttonLabel}</button></div>}
  </div>;
}

function Row({ title, value, emphasize = false }: { title: string; value: string; emphasize?: boolean }) {
  return <div className="flex items-start justify-between gap-4"><span className="text-smoke">{title}</span><span className={`max-w-[55%] text-right font-medium tabular-nums ${emphasize ? "text-cream" : "text-cream/80"}`}>{value}</span></div>;
}

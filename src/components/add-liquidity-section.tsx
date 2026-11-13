"use client";

import type { ReactNode } from "react";
import { ArrowDown, CircleAlert, LoaderCircle } from "lucide-react";
import { formatAmount } from "@sofinance/engine/amount";
import { shortAddress } from "@/lib/format/address";
import { solscanTxUrl } from "@/lib/format/explorer";
import { TokenPicker } from "./token-picker";

const short = shortAddress;

const money = (value: string, decimals: number, digits = 6) => formatAmount(value, decimals, digits);

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

function Row({ title, value, emphasize = false }: { title: string; value: string; emphasize?: boolean }) {
  return <div className="flex items-start justify-between gap-4"><span className="text-smoke">{title}</span><span className={`max-w-[55%] text-right font-medium tabular-nums ${emphasize ? "text-cream" : "text-cream/80"}`}>{value}</span></div>;
}

type PositionState = {
  pricing?: { priceUsdInput?: number | null };
  inputBalance: string;
  inputDecimals: number;
  mintA: string;
  mintB: string;
} | null;

type Quote = {
  roundtripCostInput?: string | null;
  requested: string;
  inputDecimals: number;
  feeBps: number;
  feeAmount: string;
  spendA: string;
  minOutA: string;
  decimalsA: number;
  spendB: string;
  minOutB: string;
  decimalsB: number;
  liquidity?: string | null;
  expiresAt: number;
} | null;

type PreviewResult = {
  expiresAt?: number;
  simulatedSolDebitLamports?: string | null;
  simulated?: boolean;
} | null;

type Attempt = {
  signature: string;
  positionMint: string;
} | null;

export function AddLiquiditySection({
  hidden,
  assetOptions,
  selectedAsset,
  metadata,
  busy,
  onSelectAsset,
  inputPriceUsd,
  amount,
  onChangeAmount,
  onFillMax,
  inputLabel,
  state,
  tolerancePercent,
  onChangeTolerance,
  actionDisabled,
  actionLoading,
  buttonClass,
  buttonLabel,
  onPrimaryAction,
  addStatus,
  connected,
  connectionError,
  displayError,
  showQuoteRecalculate,
  onRetryCalculation,
  reprepare,
  calculating,
  quote,
  fresh,
  now,
  result,
  totalCostPercent,
  poolLabel,
  attempt,
  visibleAttempt,
  attemptStatus,
  onOpenStatus,
}: {
  hidden: boolean;
  assetOptions: Parameters<typeof TokenPicker>[0]["assets"];
  selectedAsset: Parameters<typeof TokenPicker>[0]["selectedAsset"];
  metadata: Parameters<typeof TokenPicker>[0]["metadata"];
  busy: boolean;
  onSelectAsset: Parameters<typeof TokenPicker>[0]["onSelect"];
  inputPriceUsd: number | null | undefined;
  amount: string;
  onChangeAmount: (value: string) => void;
  onFillMax: () => void;
  inputLabel: string;
  state: PositionState;
  tolerancePercent: string;
  onChangeTolerance: (value: string) => void;
  actionDisabled: boolean;
  actionLoading: boolean;
  buttonClass: string;
  buttonLabel: string;
  onPrimaryAction: () => void;
  addStatus: ReactNode;
  connected: boolean;
  connectionError: string;
  displayError: ReactNode;
  showQuoteRecalculate: boolean;
  onRetryCalculation: () => void;
  reprepare: boolean;
  calculating: boolean;
  quote: Quote;
  fresh: boolean;
  now: number;
  result: PreviewResult;
  totalCostPercent: string | null;
  poolLabel: (mint: string) => string;
  attempt: Attempt;
  visibleAttempt: Attempt;
  attemptStatus: string;
  onOpenStatus: () => void;
}) {
  const addButton = <>
    {actionLoading
      ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />
      : <ArrowDown aria-hidden="true" className="h-4 w-4" />}
    {buttonLabel}
  </>;

  return <>
    <div id="deposit-view" hidden={hidden}>
      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)]">
        <section className="min-w-0 rounded-[28px] border border-white/12 bg-char p-5 sm:p-8">
          <h2 className="text-lg font-semibold text-cream">Add to existing position</h2>
          <p className="mt-2 text-xs leading-5 text-smoke">Choose an asset from your wallet. We swap it into the pool tokens as needed, then add liquidity to the existing LP position selected above in one transaction. Your position keeps its current price range.</p>
          <span id="asset-label" className="mt-6 block text-xs font-medium uppercase tracking-[0.16em] text-smoke">Asset to add from wallet</span>
          <TokenPicker assets={assetOptions} selectedAsset={selectedAsset} metadata={metadata} disabled={!assetOptions.length || busy} onSelect={onSelectAsset} inputPriceUsd={inputPriceUsd} />
          {selectedAsset && <details className="mt-2 text-[11px] leading-5 text-smoke/70">
            <summary className="cursor-pointer">Asset address and balance source</summary>
            <p className="mt-2 break-all">Mint {selectedAsset.mint} · Available for input ATA/SOL balance {money(selectedAsset.balance, selectedAsset.decimals, selectedAsset.decimals)}{selectedAsset.totalBalance !== selectedAsset.balance ? `; wallet total holdings ${money(selectedAsset.totalBalance, selectedAsset.decimals, selectedAsset.decimals)}` : ""}</p>
          </details>}
          <label htmlFor="amount" className="mt-7 block text-xs font-medium uppercase tracking-[0.16em] text-smoke">Input limit</label>
          <div className="mt-2 flex items-center gap-2 rounded-2xl border border-white/20 bg-white/[0.06] px-4 py-3 focus-within:border-white/40">
            <input id="amount" disabled={busy || !state} inputMode="decimal" placeholder="0.00" value={amount} onChange={(event) => onChangeAmount(event.target.value)} className="min-w-0 flex-1 bg-transparent text-3xl font-semibold text-cream outline-none placeholder:text-smoke/50" />
            <span className="text-sm font-semibold text-cream/80">{inputLabel}</span>
          </div>
          {state?.pricing?.priceUsdInput !== undefined && state.pricing.priceUsdInput !== null && amount && (() => {
            const inputUsd = calculateInputUsd(amount, state.pricing.priceUsdInput);
            return inputUsd ? <div className="mt-2 text-center text-sm text-smoke/70">{inputUsd}</div> : null;
          })()}
          <div className="mt-3 flex items-center justify-between text-xs text-smoke">
            <span>Available for input balance: {state ? `${money(state.inputBalance, state.inputDecimals, state.inputDecimals)} ${inputLabel}` : "—"}</span>
            <button type="button" className="font-semibold text-cream/80 hover:text-cream disabled:opacity-40" onClick={onFillMax} disabled={busy || !state}>MAX</button>
          </div>
          <details className="mt-5 text-xs text-smoke">
            <summary className="cursor-pointer font-semibold">Advanced settings · Price tolerance {tolerancePercent}%</summary>
            <div className="mt-3 flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3">
              <div>
                <label htmlFor="tolerance" className="text-sm font-medium text-cream/80">Add-liquidity price tolerance</label>
                <p className="mt-1 text-xs leading-5 text-smoke">Room for the pool price to move before execution; 0–5%, by 0.1%. The unused reserve stays in your wallet as pool assets.</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <input id="tolerance" disabled={busy} type="number" inputMode="decimal" min="0" max="5" step="0.1" value={tolerancePercent} onChange={(event) => onChangeTolerance(event.target.value)} className="w-16 rounded-lg border border-white/20 bg-white/10 px-2 py-1.5 text-right text-base sm:text-sm font-semibold text-cream outline-none focus:border-white/40" />
                <span className="text-sm text-cream/80">%</span>
              </div>
            </div>
          </details>
          <p className="mt-5 text-xs leading-5 text-smoke">Preview updates after entering an amount. Add liquidity runs the final checks before wallet confirmation.</p>
          <div className="mt-6 hidden sm:block">
            <button className={buttonClass} disabled={actionDisabled} aria-busy={actionLoading} onClick={onPrimaryAction}>{addButton}</button>
          </div>
          {connected && <div role="status" className="mt-3 min-h-5 text-xs text-smoke">{addStatus}</div>}
          {connectionError && <div role="alert" className="mt-4 flex gap-2 rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-sm text-cream/80"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />{connectionError}</div>}
          {displayError && <div role="alert" className="mt-4 flex gap-2 rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-sm text-cream/80">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="flex-1">{displayError}</span>
            {showQuoteRecalculate && <button type="button" onClick={onRetryCalculation} data-testid="add-recalculate" className="shrink-0 font-semibold underline">Recalculate</button>}
            {reprepare && !showQuoteRecalculate && <button type="button" onClick={onPrimaryAction} disabled={actionDisabled} data-testid="add-reprepare" className="shrink-0 font-semibold underline disabled:opacity-40">{actionDisabled ? "Getting a fresh quote…" : "Try again"}</button>}
          </div>}
        </section>

        <aside className="min-w-0 space-y-3">
          <section className="rounded-[28px] border border-white/12 bg-char p-5 sm:p-7">
            <h2 className="text-lg font-semibold text-cream">Add liquidity preview</h2>
            <p className="mt-2 text-xs leading-5 text-smoke">
              {calculating
                ? <span role="status" className="inline-flex items-center gap-2 text-cream/80"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Estimating liquidity…</span>
                : quote
                  ? fresh
                    ? `Preview valid for approximately ${Math.max(0, Math.ceil(((result?.expiresAt ?? quote.expiresAt) - now) / 1000))} seconds`
                    : "Preview expired, updating"
                  : "Auto-calculate after selecting position and asset, entering amount"}
            </p>
            {quote && <>
              {totalCostPercent !== null && <p className="mt-2 text-xs leading-5 text-smoke/70">Total cost uses the conservative swap outputs (liquidity added plus the price-tolerance reserve left in your wallet), estimates immediate swap back to original input asset; not actual sale, also does not represent dollar value.</p>}
              <div className="mt-7 space-y-4 text-sm">
                <Row title="Input limit" value={quote ? `${money(quote.requested, quote.inputDecimals)} ${inputLabel}` : "—"} />
                {quote.feeBps > 0 && <Row title={`Protocol fee (${(quote.feeBps / 100).toFixed(2)}%)`} value={`${money(quote.feeAmount, quote.inputDecimals)} ${inputLabel}`} />}
                <div className="border-t border-white/10" />
                <Row title={`Swap to ${state ? poolLabel(state.mintA) : "Pool A"} · minOut`} value={quote ? quote.spendA === "0" ? "no swap needed" : money(quote.minOutA, quote.decimalsA) : "—"} />
                <Row title={`Swap to ${state ? poolLabel(state.mintB) : "Pool B"} · minOut`} value={quote ? quote.spendB === "0" ? "no swap needed" : money(quote.minOutB, quote.decimalsB) : "—"} />
                <Row title="Estimated liquidity added" value={quote?.liquidity || "—"} />
                <div className="border-t border-white/10" />
                {totalCostPercent !== null && <Row title="Total cost" value={`~${totalCostPercent}%`} emphasize />}
                <Row title="Jupiter transaction slippage" value="0.5%(fixed)" />
                <Row title="Simulated SOL total debit" value={result?.simulatedSolDebitLamports ? `${money(result.simulatedSolDebitLamports, 9, 9)} SOL(including input and possible rent)` : "Checked when you add liquidity"} />
              </div>
              {totalCostPercent !== null && <p className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-xs leading-5 text-smoke">Estimated round-trip cost: about {totalCostPercent ?? "—"}% (assuming you add liquidity, immediately withdraw, and swap back to {inputLabel}). This conservative estimate includes swap fees, price impact, and slippage tolerance. It does not block signing. Network fees and account rent are separate. This value is not a promise of execution or future value.</p>}
            </>}
          </section>
          {(attempt || result?.simulated) && <section className="rounded-[28px] border border-white/12 bg-char p-5">
            <h2 className="font-semibold text-cream">Add liquidity transaction</h2>
            <p role="status" className="mt-2 text-xs leading-5 text-smoke">{attemptStatus ? `Transaction status: ${attemptStatus}` : addStatus}</p>
            {attempt && <p className="mt-3 text-xs text-cream/80"><a href={solscanTxUrl(attempt.signature)} target="_blank" rel="noreferrer" className="underline">View transaction {short(attempt.signature)}</a> · NFT {short(attempt.positionMint)}</p>}
          </section>}
          {visibleAttempt && <button type="button" onClick={onOpenStatus} className="w-full rounded-full bg-lemon px-5 py-3 text-sm font-semibold text-ink transition-colors hover:bg-[#fff27f]/80 transition-colors hover:bg-white/[0.04]">View transaction status and tx hash</button>}
        </aside>
      </div>
    </div>
  </>;
}


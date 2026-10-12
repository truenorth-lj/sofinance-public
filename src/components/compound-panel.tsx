"use client";

import { ArrowUpRight, CircleAlert, LoaderCircle, RefreshCw, Sprout } from "lucide-react";
import { useState } from "react";
import { CompoundOverview } from "./compound-overview";
import { useSolUsdcPrices } from "./use-sol-usdc-price";
import { formatAmount } from "@/lib/amount";
import type { CompoundController } from "./use-compound-controller";

const short = (value: string) => `${value.slice(0, 5)}…${value.slice(-5)}`;

const statusText = {
  pending: "Transaction confirming, do not resubmit",
  success: "Compound confirmed on-chain",
  failed: "On-chain transaction failed",
  expired: "Transaction not on-chain and expired",
  "manual-review": "Transaction result requires manual verification, new transactions paused",
} as const;

export function CompoundPanel({ controller: c, tokenLabel = short, onConnect }: {
  controller: CompoundController; tokenLabel?: (mint: string) => string; onConnect?: () => void;
}) {
  const [importSignature, setImportSignature] = useState("");
  const prices = useSolUsdcPrices();
  const state = c.state;
  const preview = c.preview;
  const summary = preview || (c.attempt?.kind === "compound" ? c.attempt.summary : null);
  const displaySummary = summary?.positionMint === c.positionMint ? summary : preview;
  const amount = (value: string, decimals: number) => formatAmount(value, decimals, Math.min(decimals, 9));
  const action = c.stage === "preparing" ? "Verifying yield and simulating transaction…" :
    c.stage === "wallet" ? "Confirming in wallet…" : c.stage === "broadcasting" ? "Sending and verifying…" : "One-click compound";
  const blockedText = !c.wallet ? null : !c.positionMint ? "Please select existing position first" :
    c.externalBlocked ? "Input transaction pending verification, compound paused" : c.receiptReviewRequired ?
      "Previous transaction finalized successfully; verify yield details before another compound or recovery. You can add liquidity." : c.walletBlocked && !c.busy ?
      c.confirmationSlow ? "Confirmation is taking longer than 30 seconds. Rechecking on-chain result; do not resubmit." :
      "Verifying this wallet's previous transactions, do not resubmit" : state && !state.eligible ? state.reason :
        state && !c.hasFees ? "Currently no yield available to compound" : null;
  return <section aria-labelledby="compound-heading" className="mt-6 rounded-[28px] border border-white/12 bg-char p-5 sm:p-8">
    <div className="flex items-center justify-between gap-4">
      <div><h2 id="compound-heading" className="flex items-center gap-2 text-lg font-semibold text-cream"><Sprout className="h-5 w-5 text-cream/80" />Yield Compound</h2>
        <p className="mt-2 text-xs leading-5 text-smoke">Harvest this position&apos;s yield, swap to ratio needed for original range, then add back to original NFT. Signed by your wallet each time.</p></div>
      <button type="button" onClick={() => void c.refreshState()} disabled={!c.wallet || !c.positionMint || c.loading || c.busy}
        className="shrink-0 text-xs font-semibold text-cream/80 transition-opacity hover:opacity-70 disabled:opacity-40"><RefreshCw className={`mb-1 inline h-3.5 w-3.5 ${c.loading ? "animate-spin" : ""}`} /> Reload yield</button>
    </div>
    {state && <>
      <CompoundOverview state={state} summary={preview} tokenLabel={tokenLabel} prices={prices} />
      {c.priorReceipts.length > 0 && <p className="mt-3 text-xs leading-5 text-cream/80">Will verify this NFT&apos;s {c.priorReceipts.length} prior yield account records, and swap and reinvest yield still in accounts together; actual available amount subject to on-chain query.</p>}
      {state.rewards.some((reward) => reward.estimatedAmount !== "0") && <div className="mt-4 space-y-2 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <h3 className="text-xs font-medium text-smoke">Additional rewards</h3>
        {state.rewards.map((reward) => <div key={reward.index} className="flex justify-between gap-3 text-xs text-cream/80">
          <span>{amount(reward.estimatedAmount, reward.decimals)} {tokenLabel(reward.mint)}</span>
          <span className="text-smoke">{reward.estimatedAmount === "0" ? "Currently no pending rewards" : reward.compounded ? "Same pool assets, can be reinvested with yield" : "Requires supported swap route, will not send if cannot complete"}</span>
        </div>)}
      </div>}
    </>}
    {state?.rangeSide !== "inside" && state && <p className="mt-4 text-xs leading-5 text-smoke">Current price outside original range; yield compound still maintains original ticks, do not adjust price range, no trading fees earned for that range while outside.</p>}
    <div className="mt-5 flex flex-wrap items-center gap-4">
      <button type="button" onClick={() => { if (!c.wallet) { onConnect?.(); return; } c.compound(); }} disabled={Boolean(c.wallet) && !c.canCompound} className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-lemon px-5 py-3.5 text-sm font-semibold text-ink transition-colors hover:bg-[#fff27f] disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto sm:min-w-48">
        {c.busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sprout className="h-4 w-4" />}{action}
      </button>
      <a href="/app/ai" className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-white/25 px-5 py-3.5 text-sm font-semibold text-cream transition-colors hover:border-white/50 hover:bg-white/[0.04] sm:w-auto">Auto Copilot <ArrowUpRight className="h-4 w-4" /></a>
      <span role="status" className="text-xs text-smoke">{c.loading ? "Loading latest yield…" : blockedText}</span>
    </div>
    {c.attempt && <div className="mt-5 rounded-2xl border border-white/10 p-4 text-xs leading-6">
      <div className="flex flex-wrap items-center justify-between gap-2"><p role="status" className="text-cream/90">
        {c.receiptReviewRequired ? "Transaction finalized successfully; yield details require verification. Add liquidity is available."
          : c.attempt.kind === "recovery" && c.attemptStatus === "success" ? "Balance and account rent recovered"
          : c.attemptStatus === "pending" && c.error ? "Last attempt did not confirm; see the error below"
          : c.attemptStatus ? statusText[c.attemptStatus] : "Loading records"}
      </p><a className="text-cream/80 underline" href={`https://solscan.io/tx/${c.attempt.signature}`} target="_blank" rel="noreferrer">View transaction {short(c.attempt.signature)}</a></div>
      {c.confirmation?.receipt && c.attempt.kind === "compound" && <p className="mt-2 text-cream/80">Actual input: {amount(c.confirmation.receipt.investedA, c.attempt.summary.state.decimalsA)} {tokenLabel(c.attempt.summary.state.mintA)}  +  {amount(c.confirmation.receipt.investedB, c.attempt.summary.state.decimalsB)} {tokenLabel(c.attempt.summary.state.mintB)}</p>}
      <button type="button" onClick={c.retryReconcile} disabled={c.busy} className="mt-2 block text-cream/80 underline disabled:opacity-40">Requery on-chain result</button>
      <details className="mt-2 text-smoke/70"><summary className="cursor-pointer">Complete transaction signature and position</summary><p className="break-all">{c.attempt.signature}</p><p>NFT {c.attempt.positionMint}</p></details>
    </div>}
    {c.error && <div role="alert" className="mt-4 flex gap-2 rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-sm text-cream/80"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /><span>{c.error}</span></div>}
    {!preview && displaySummary && <details className="mt-5 text-xs text-smoke"><summary className="cursor-pointer font-semibold">Previous transaction simulation record</summary><p className="mt-3">Previous transaction estimate; a new compound will re-read yield and simulate. USDC values use current reference prices.</p><CompoundOverview state={displaySummary.state} summary={displaySummary} tokenLabel={tokenLabel} prices={prices} /></details>}
    <details className="mt-5 border-t border-white/10 pt-4 text-xs text-smoke"><summary className="cursor-pointer font-semibold">Yield account management · Recover records and retrieve balances{c.receipts.length > 0 ? `（${c.receipts.length} records)` : ""}</summary>
    <details className="mt-5 text-xs text-smoke"><summary className="cursor-pointer font-semibold">Recover yield accounts from transaction signature</summary>
      <p className="mt-2 leading-5">When switching devices or local records are lost, enter original compound transaction signature, recovered yield can be included in next compound or retrieved. Query only reads on-chain records, moving assets still requires wallet signature.</p>
      <label htmlFor="compound-import-signature" className="mt-3 block">Original compound transaction signature</label>
      <input id="compound-import-signature" value={importSignature} onChange={(event) => setImportSignature(event.target.value)}
        className="mt-2 w-full rounded-lg border border-white/20 bg-white/[0.06] px-3 py-2 text-xs text-cream focus:border-white/40 focus:outline-none" autoComplete="off" />
      <button disabled={!c.canImport || !importSignature.trim()} onClick={() => void c.importReceipt(importSignature)}
        className="mt-3 inline-flex items-center justify-center gap-2 rounded-full border border-white/20 bg-transparent px-3 py-2 text-xs font-semibold text-cream/80 transition-colors hover:border-white/40 hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-40">{c.importing ? "Querying on-chain records…" : "Recover yield account records"}</button>
    </details>
    {c.receipts.length > 0 && <div className="mt-6 border-t border-white/10 pt-5">
      <h3 className="text-sm font-semibold text-cream">Retrieve yield balances</h3>
      <p className="mt-2 text-xs leading-5 text-smoke">Selected NFT&apos;s prior yield will be verified and used together in next compound. Can also retrieve remaining pool assets and close these wallet-controlled accounts, refunding rent.</p>
      <div className="mt-3 space-y-3">{c.receipts.map((receipt) => <div key={receipt.sourceSignature} className="rounded-2xl border border-white/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-smoke">NFT {short(receipt.positionMint)} · original transaction <a href={`https://solscan.io/tx/${receipt.sourceSignature}`} target="_blank" rel="noreferrer" className="text-cream/80 underline">{short(receipt.sourceSignature)}</a></span>
          <button onClick={() => c.recover(receipt)} disabled={!c.ready || c.busy} className="inline-flex items-center justify-center gap-2 rounded-full border border-white/20 bg-transparent px-3 py-2 text-xs font-semibold text-cream/80 transition-colors hover:border-white/40 hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-40">Retrieve this balance</button></div>
        <details className="mt-2 text-[11px] leading-5 text-smoke/70"><summary className="cursor-pointer">View wallet-controlled yield accounts</summary>{receipt.compoundAccounts.map((account) => <p key={account.address} className="break-all"><a href={`https://solscan.io/account/${account.address}`} target="_blank" rel="noreferrer" className="text-cream/80 underline">{account.address}</a> · {tokenLabel(account.mint)}</p>)}</details>
      </div>)}</div>
    </div>}
    </details>
  </section>;
}

"use client";

import { CircleAlert, LoaderCircle, RefreshCw, Sprout } from "lucide-react";
import { useState } from "react";
import { formatAmount } from "@/lib/amount";
import type { CompoundController } from "./use-compound-controller";

const short = (value: string) => `${value.slice(0, 5)}…${value.slice(-5)}`;

function calculateUsdValue(rawAmount: string, decimals: number, priceUsd: number | null): string | null {
  if (priceUsd === null || !Number.isFinite(priceUsd) || priceUsd < 0) return null;
  try {
    const amount = Number(rawAmount) / Math.pow(10, decimals);
    if (!Number.isFinite(amount) || amount < 0) return null;
    const usdValue = amount * priceUsd;
    if (!Number.isFinite(usdValue)) return null;
    return usdValue < 0.01 ? "< $0.01" : `≈ $${usdValue.toFixed(2)}`;
  } catch {
    return null;
  }
}

const statusText = {
  pending: "Transaction confirming, do not resubmit",
  success: "Compound confirmed on-chain",
  failed: "On-chain transaction failed",
  expired: "Transaction not on-chain and expired",
  "manual-review": "Transaction result requires manual verification, new transactions paused",
} as const;

export function CompoundPanel({ controller: c, tokenLabel = short }: {
  controller: CompoundController; tokenLabel?: (mint: string) => string;
}) {
  const [importSignature, setImportSignature] = useState("");
  const state = c.state;
  const preview = c.preview;
  const summary = preview || (c.attempt?.kind === "compound" ? c.attempt.summary : null);
  const displaySummary = summary?.positionMint === c.positionMint ? summary : preview;
  const a = state ? tokenLabel(state.mintA) : "Pool A";
  const b = state ? tokenLabel(state.mintB) : "Pool B";
  const amount = (value: string, decimals: number) => formatAmount(value, decimals, Math.min(decimals, 9));
  const action = c.stage === "preparing" ? "Verifying yield and simulating transaction…" :
    c.stage === "wallet" ? "Confirming in wallet…" : c.stage === "broadcasting" ? "Sending and verifying…" : "One-click compound";
  const blockedText = !c.wallet ? "Please connect wallet first" : !c.positionMint ? "Please select existing position first" :
    c.externalBlocked ? "Input transaction pending verification, compound paused" : c.walletBlocked && !c.busy ?
      "Verifying this wallet's previous transactions, do not resubmit" : state && !state.eligible ? state.reason :
        state && !c.hasFees ? "Currently no yield available to compound" : null;
  const simulationDetails = displaySummary && <div className="mt-5 space-y-3 rounded-2xl border border-neutral-800/60 bg-neutral-900/30 p-4 text-sm">
      <h3 className="font-semibold text-neutral-100">{preview ? "This transaction simulation" : "Previous transaction simulation record"}</h3>
      {!preview && <p className="text-xs text-neutral-500">This is previous transaction estimate; clicking &quot;One-click compound&quot; will re-read yield and simulate.</p>}
      <p className="text-neutral-300">This harvest: {amount(displaySummary.simulatedHarvest.a, displaySummary.state.decimalsA)} {tokenLabel(displaySummary.state.mintA)}  +  {amount(displaySummary.simulatedHarvest.b, displaySummary.state.decimalsB)} {tokenLabel(displaySummary.state.mintB)}</p>
      {(displaySummary.priorSources?.length || 0) > 0 && <div className="space-y-1 text-xs text-neutral-400"><p>Prior yield to be reinvested together:</p>{displaySummary.priorSources?.map((source) => <p key={source.address}>
        {amount(source.amount, source.mint === displaySummary.state.mintA ? displaySummary.state.decimalsA : displaySummary.state.decimalsB)} {tokenLabel(source.mint)} · original transaction {short(source.sourceSignature)}
      </p>)}</div>}
      {(displaySummary.swaps?.length || 0) > 0 && <div className="space-y-2 rounded-xl border border-neutral-800/40 bg-neutral-900/40 p-3 text-xs text-neutral-300"><h4 className="font-semibold text-neutral-100">Yield swap</h4>{displaySummary.swaps?.map((swap, index) => <div key={`${swap.inputMint}:${swap.outputMint}:${index}`}>
        <p>{amount(swap.inputAmount, swap.inputDecimals)} {tokenLabel(swap.inputMint)} → {amount(swap.simulatedOutputAmount || swap.quotedOutputAmount, swap.outputDecimals)} {tokenLabel(swap.outputMint)}</p>
        <p className="mt-1 text-neutral-500">Minimum received {amount(swap.minOutputAmount, swap.outputDecimals)} {tokenLabel(swap.outputMint)}；Below this amount, entire transaction will fail.</p>
      </div>)}</div>}
      <p className="text-neutral-300">This input limit: {amount(displaySummary.amountMaxA, displaySummary.state.decimalsA)} {tokenLabel(displaySummary.state.mintA)}  +  {amount(displaySummary.amountMaxB, displaySummary.state.decimalsB)} {tokenLabel(displaySummary.state.mintB)}</p>
      <p className="text-xs text-neutral-500">Simulated remaining: {amount(displaySummary.simulatedDustA, displaySummary.state.decimalsA)} {tokenLabel(displaySummary.state.mintA)}  +  {amount(displaySummary.simulatedDustB, displaySummary.state.decimalsB)} {tokenLabel(displaySummary.state.mintB)}. Swap slippage and integer calculations may leave small balances, can be used together in next compound or recovered.</p>
      <p className="text-xs text-neutral-500">Estimated SOL fee {amount(String(displaySummary.feeLamports), 9)} SOL；Account creation reserved {amount(String(displaySummary.rentLamports), 9)} SOL. Of which yield account rent {amount(String(displaySummary.compoundAccounts.reduce((sum, account) => sum + account.rentLamports, 0)), 9)} SOL, refundable when recovering and closing these accounts.</p>
    </div>;
  return <section aria-labelledby="compound-heading" className="mt-6 rounded-[20px] border border-neutral-800/80 bg-[#0a0a0a] p-5 sm:p-8">
    <div className="flex items-center justify-between gap-4">
      <div><h2 id="compound-heading" className="flex items-center gap-2 text-lg font-semibold text-neutral-100"><Sprout className="h-5 w-5 text-neutral-300" />Yield Compound</h2>
        <p className="mt-2 text-xs leading-5 text-neutral-500">Harvest this position&apos;s yield, swap to ratio needed for original range, then add back to original NFT. Signed by your wallet each time.</p></div>
      <button type="button" onClick={() => void c.refreshState()} disabled={!c.wallet || !c.positionMint || c.loading || c.busy}
        className="shrink-0 text-xs font-semibold text-neutral-300 transition-opacity hover:opacity-70 disabled:opacity-40"><RefreshCw className={`mb-1 inline h-3.5 w-3.5 ${c.loading ? "animate-spin" : ""}`} /> Reload yield</button>
    </div>
    {state && <>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <YieldItem title={`Pending trading fees · ${a}`} value={`${amount(state.fees.a, state.decimalsA)} ${a}`} 
          usdValue={state.pricing ? calculateUsdValue(state.fees.a, state.decimalsA, state.pricing.priceUsdA) : null} />
        <YieldItem title={`Pending trading fees · ${b}`} value={`${amount(state.fees.b, state.decimalsB)} ${b}`}
          usdValue={state.pricing ? calculateUsdValue(state.fees.b, state.decimalsB, state.pricing.priceUsdB) : null} />
      </div>
      <p className="mt-2 text-xs leading-5 text-neutral-600">Pending amounts are current on-chain estimates; after clicking &quot;One-click compound&quot; will re-read, simulate harvest, swap and increase. Only uses assets in yield accounts.</p>
      {c.priorReceipts.length > 0 && <p className="mt-3 text-xs leading-5 text-neutral-300">Will verify this NFT&apos;s {c.priorReceipts.length} prior yield account records, and swap and reinvest yield still in accounts together; actual available amount subject to on-chain query.</p>}
      {state.rewards.some((reward) => reward.estimatedAmount !== "0") && <div className="mt-4 space-y-2 rounded-xl border border-neutral-800/40 bg-neutral-900/30 p-4">
        <h3 className="text-xs font-medium text-neutral-400">Additional rewards</h3>
        {state.rewards.map((reward) => <div key={reward.index} className="flex justify-between gap-3 text-xs text-neutral-300">
          <span>{amount(reward.estimatedAmount, reward.decimals)} {tokenLabel(reward.mint)}</span>
          <span className="text-neutral-500">{reward.estimatedAmount === "0" ? "Currently no pending rewards" : reward.compounded ? "Same pool assets, can be reinvested with yield" : "Requires supported swap route, will not send if cannot complete"}</span>
        </div>)}
      </div>}
    </>}
    {preview && simulationDetails}
    {state?.rangeSide !== "inside" && state && <p className="mt-4 text-xs leading-5 text-neutral-400">Current price outside original range; yield compound still maintains original ticks, do not adjust price range, no trading fees earned for that range while outside.</p>}
    <div className="mt-5 flex flex-wrap items-center gap-4">
      <button onClick={c.compound} disabled={!c.canCompound} className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-neutral-700 bg-transparent px-4 py-3.5 text-sm font-semibold text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-900/50 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto sm:min-w-48">
        {c.busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sprout className="h-4 w-4" />}{action}
      </button>
      <span role="status" className="text-xs text-neutral-500">{c.loading ? "Loading latest yield…" : blockedText}</span>
    </div>
    {c.attempt && <div className="mt-5 rounded-xl border border-neutral-800/60 p-4 text-xs leading-6">
      <div className="flex flex-wrap items-center justify-between gap-2"><p role="status" className="text-neutral-200">
        {c.attempt.kind === "recovery" && c.attemptStatus === "success" ? "Balance and account rent recovered" : c.attemptStatus ? statusText[c.attemptStatus] : "Loading records"}
      </p><a className="text-neutral-300 underline" href={`https://solscan.io/tx/${c.attempt.signature}`} target="_blank" rel="noreferrer">View transaction {short(c.attempt.signature)}</a></div>
      {c.confirmation?.receipt && c.attempt.kind === "compound" && <p className="mt-2 text-neutral-300">Actual input: {amount(c.confirmation.receipt.investedA, c.attempt.summary.state.decimalsA)} {tokenLabel(c.attempt.summary.state.mintA)}  +  {amount(c.confirmation.receipt.investedB, c.attempt.summary.state.decimalsB)} {tokenLabel(c.attempt.summary.state.mintB)}</p>}
      <button type="button" onClick={c.retryReconcile} disabled={c.busy} className="mt-2 block text-neutral-300 underline disabled:opacity-40">Requery on-chain result</button>
      <details className="mt-2 text-neutral-600"><summary className="cursor-pointer">Complete transaction signature and position</summary><p className="break-all">{c.attempt.signature}</p><p>NFT {c.attempt.positionMint}</p></details>
    </div>}
    {c.error && <div role="alert" className="mt-4 flex gap-2 rounded-xl border border-neutral-700 bg-neutral-900/50 p-3 text-sm text-neutral-300"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /><span>{c.error}</span></div>}
    {!preview && simulationDetails && <details className="mt-5 text-xs text-neutral-500"><summary className="cursor-pointer font-semibold">Previous transaction simulation record</summary>{simulationDetails}</details>}
    <details className="mt-5 border-t border-neutral-800/60 pt-4 text-xs text-neutral-500"><summary className="cursor-pointer font-semibold">Yield account management · Recover records and retrieve balances{c.receipts.length > 0 ? `（${c.receipts.length} records)` : ""}</summary>
    <details className="mt-5 text-xs text-neutral-500"><summary className="cursor-pointer font-semibold">Recover yield accounts from transaction signature</summary>
      <p className="mt-2 leading-5">When switching devices or local records are lost, enter original compound transaction signature, recovered yield can be included in next compound or retrieved. Query only reads on-chain records, moving assets still requires wallet signature.</p>
      <label htmlFor="compound-import-signature" className="mt-3 block">Original compound transaction signature</label>
      <input id="compound-import-signature" value={importSignature} onChange={(event) => setImportSignature(event.target.value)}
        className="mt-2 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs text-neutral-100 focus:border-neutral-600 focus:outline-none" autoComplete="off" />
      <button disabled={!c.canImport || !importSignature.trim()} onClick={() => void c.importReceipt(importSignature)}
        className="mt-3 inline-flex items-center justify-center gap-2 rounded-xl border border-neutral-700 bg-transparent px-3 py-2 text-xs font-semibold text-neutral-300 transition-colors hover:border-neutral-600 hover:bg-neutral-900/50 disabled:cursor-not-allowed disabled:opacity-40">{c.importing ? "Querying on-chain records…" : "Recover yield account records"}</button>
    </details>
    {c.receipts.length > 0 && <div className="mt-6 border-t border-neutral-800/60 pt-5">
      <h3 className="text-sm font-semibold text-neutral-100">Retrieve yield balances</h3>
      <p className="mt-2 text-xs leading-5 text-neutral-500">Selected NFT&apos;s prior yield will be verified and used together in next compound. Can also retrieve remaining pool assets and close these wallet-controlled accounts, refunding rent.</p>
      <div className="mt-3 space-y-3">{c.receipts.map((receipt) => <div key={receipt.sourceSignature} className="rounded-xl border border-neutral-800/60 p-3">
        <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-neutral-500">NFT {short(receipt.positionMint)} · original transaction <a href={`https://solscan.io/tx/${receipt.sourceSignature}`} target="_blank" rel="noreferrer" className="text-neutral-300 underline">{short(receipt.sourceSignature)}</a></span>
          <button onClick={() => c.recover(receipt)} disabled={!c.ready || c.busy} className="inline-flex items-center justify-center gap-2 rounded-xl border border-neutral-700 bg-transparent px-3 py-2 text-xs font-semibold text-neutral-300 transition-colors hover:border-neutral-600 hover:bg-neutral-900/50 disabled:cursor-not-allowed disabled:opacity-40">Retrieve this balance</button></div>
        <details className="mt-2 text-[11px] leading-5 text-neutral-600"><summary className="cursor-pointer">View wallet-controlled yield accounts</summary>{receipt.compoundAccounts.map((account) => <p key={account.address} className="break-all"><a href={`https://solscan.io/account/${account.address}`} target="_blank" rel="noreferrer" className="text-neutral-300 underline">{account.address}</a> · {tokenLabel(account.mint)}</p>)}</details>
      </div>)}</div>
    </div>}
    </details>
  </section>;
}

function YieldItem({ title, value, usdValue }: { title: string; value: string; usdValue?: string | null }) {
  return <div className="min-w-0 rounded-xl border border-neutral-800/40 bg-neutral-900/30 p-3 sm:p-4">
    <div className="text-xs text-neutral-500">{title}</div>
    <div className="mt-2 break-all text-sm font-semibold tabular-nums text-neutral-100">{value}</div>
    {usdValue && <div className="mt-1 text-xs text-neutral-600">{usdValue}</div>}
  </div>;
}

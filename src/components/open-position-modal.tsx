"use client";

import { useId, useState } from "react";
import { formatAmount } from "@/lib/amount";
import { formatPositionPriceRange, formatRangeStatus, tokenSymbol } from "@/lib/position-label";
import { ChevronDown, Info, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useOpenPositionController, type OpenPositionPair } from "./use-open-position-controller";

const FIELD_HELP = {
  "Token A": "The conservative amount of token A available to open your LP position. The position may use less; any remaining tokens stay in your wallet.",
  "Token B": "The conservative amount of token B available to open your LP position. The position may use less; any remaining tokens stay in your wallet.",
  "Aligned range": "Your actual price range after alignment to the pool's supported ticks, expressed as token B per 1 token A.",
  "Status": "In range means the current pool price is within your selected range and the position can earn trading fees. It stops earning trading fees while the price is outside the range.",
  "Quote validity": "Time remaining before this quote expires. Quotes refresh every 3 seconds, and transaction preparation obtains a fresh quote. Expired quotes cannot be signed.",
  "Price impact cap": "The maximum price impact allowed for the swaps. Preparation stops if it is exceeded. This differs from slippage tolerance and does not cap the position's overall loss.",
  "Refundable rent (NFT)": "Estimated account deposits for the position NFT, its token account and your personal position account. You can recover the corresponding deposits when the position and accounts are closed.",
  "Non-refundable rent": "Estimated one-time cost to create shared protocol-position or tick-array accounts. These accounts remain after your position closes, so this cost is not returned to you.",
  "Network fee (est.)": "Estimated Solana transaction fee, confirmed during preparation. It is separate from your investment and account deposits.",
  "Wallet SOL": "Your wallet's total SOL balance. Keep enough SOL to cover account deposits and network fees in addition to your investment.",
} as const;

function FieldLabel({ label }: { label: keyof typeof FIELD_HELP }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <dt className="relative flex items-center gap-1.5 text-neutral-500" onMouseEnter={() => setOpen(true)} onMouseLeave={(event) => { if (!event.currentTarget.contains(document.activeElement)) setOpen(false); }}>
      {label}
      <button type="button" aria-label={`About ${label}`} aria-describedby={open ? id : undefined}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onClick={(event) => { event.currentTarget.focus(); setOpen(true); }}
        onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}
        className="inline-flex shrink-0 rounded text-neutral-500 hover:text-neutral-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400">
        <Info size={24} strokeWidth={2} className="preview-icon h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open && <span id={id} role="tooltip" className="absolute left-0 top-full z-20 mt-1 w-64 max-w-[75vw] rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-left text-xs font-normal leading-5 text-neutral-200 shadow-xl">
        {FIELD_HELP[label]}
      </span>}
    </dt>
  );
}

function explainTokenWarning(warning: string) {
  if (warning.startsWith("One or both pool tokens use Token-2022.")) {
    return "One or both tokens use Token-2022, which supports additional token features. Assets with active transfer fees, paused transfers or frozen accounts are blocked. The issuer may still retain freeze authority.";
  }
  if (warning.startsWith("A pool mint has a freeze authority.")) {
    return "The issuer can freeze token accounts in the future, which may block transfers or LP deposits and withdrawals. This does not mean the accounts are currently frozen.";
  }
  return warning;
}

function isDetailWarning(warning: string) {
  return warning.startsWith("One or both pool tokens use Token-2022.") ||
    warning.startsWith("This tick range has no protocol position yet") ||
    warning.startsWith("This range initializes tick array(s)");
}

function lamports(value: string | number | bigint): string {
  const n = Number(value) / 1e9;
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(4)} SOL`;
}

export function OpenPositionModal({
  pair,
  onClose,
}: {
  pair: OpenPositionPair;
  onClose: () => void;
}) {
  const c = useOpenPositionController(pair);
  const quote = c.quote;
  const detailWarnings = quote?.warnings.filter(isDetailWarning) ?? [];
  const visibleWarnings = quote?.warnings.filter(warning => !isDetailWarning(warning)) ?? [];
  const upfrontCost = quote ? BigInt(quote.rent.refundableLamports) + BigInt(quote.rent.nonRefundableLamports)
    + BigInt(quote.networkFeeLamportsEstimate) : 0n;
  const label = quote
    ? `${tokenSymbol(quote.mintA, undefined, pair.symbolA)}/${tokenSymbol(quote.mintB, undefined, pair.symbolB)} · range ${formatPositionPriceRange({
      tickLower: quote.tickLower, tickUpper: quote.tickUpper,
      decimalsA: quote.decimalsA, decimalsB: quote.decimalsB,
    })}${formatRangeStatus(quote.rangeSide) ? ` · ${formatRangeStatus(quote.rangeSide)}` : ""}`
    : `${pair.wrappedSymbol}/${pair.plainSymbol}`;

  const status = c.submitStage === "preparing" ? "Preparing latest transaction…"
    : c.submitStage === "wallet" ? "Waiting for wallet signature…"
      : c.submitStage === "broadcasting" ? "Confirming on-chain…"
        : c.submitStage === "confirmed" ? "Position opened"
          : c.quoteLoading && !quote ? "Fetching quote…"
            : c.actionBlockedReason || "Ready to sign";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-labelledby="open-position-title">
      <button className="absolute inset-0 bg-black/70" aria-label="Close add liquidity" onClick={onClose} />
      <div className="relative z-10 max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-[20px] border border-neutral-800 bg-[#0a0a0a] p-5 sm:rounded-[20px] sm:p-6">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id="open-position-title" className="text-base font-semibold text-neutral-100">Add liquidity</h2>
            <p className="mt-1 text-xs leading-5 text-neutral-500">{label}</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-neutral-500 hover:text-neutral-200" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-4 flex flex-wrap gap-1">
          {(pair.token2022A || pair.token2022B) && (
            <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-400">Token-2022</span>
          )}
          {pair.freezeRisk && (
            <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-400">Freeze risk</span>
          )}
        </div>

        <label className="block text-xs text-neutral-400" htmlFor="open-input-asset">Input asset</label>
        <select
          id="open-input-asset"
          className="mt-1 w-full rounded-xl border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
          value={c.inputMint ? `${c.inputKind}:${c.inputMint}` : ""}
          onChange={(event) => {
            const [kind, mint] = event.target.value.split(":");
            if ((kind === "native" || kind === "token") && mint) c.chooseAsset(kind, mint);
          }}
        >
          <option value="">Select SOL, USDC, or a pool token</option>
          {c.inputAssets.map((asset) => {
            const label = asset.kind === "native"
              ? "SOL"
              : asset.mint === pair.mintA
                ? tokenSymbol(asset.mint, undefined, pair.symbolA)
                : asset.mint === pair.mintB
                  ? tokenSymbol(asset.mint, undefined, pair.symbolB)
                  : tokenSymbol(asset.mint);
            return (
              <option key={`${asset.kind}:${asset.mint}`} value={`${asset.kind}:${asset.mint}`}>
                {label} · {formatAmount(asset.balance, asset.decimals)}
                {asset.eligible ? "" : ` (${asset.reason || "ineligible"})`}
              </option>
            );
          })}
        </select>

        <div className="mt-3 flex items-end gap-2">
          <div className="flex-1">
            <label className="block text-xs text-neutral-400" htmlFor="open-amount">Amount</label>
            <input
              id="open-amount"
              className="mt-1 w-full rounded-xl border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
              value={c.amount}
              onChange={(event) => c.changeAmount(event.target.value)}
              inputMode="decimal"
              placeholder="0.0"
            />
          </div>
          <button
            className="rounded-xl border border-neutral-700 px-3 py-2 text-xs font-semibold text-neutral-300"
            onClick={c.fillMax}
            type="button"
          >
            Max
          </button>
        </div>

        <p className="mt-4 text-xs text-neutral-400">Price range (B per 1 A)</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {c.presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => c.choosePreset(preset.id)}
              className={`rounded-full border px-3 py-1 text-xs font-semibold ${c.rangePreset === preset.id ? "border-neutral-100 text-neutral-100" : "border-neutral-700 text-neutral-400"}`}
            >
              {preset.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => c.choosePreset("custom")}
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${c.rangePreset === "custom" ? "border-neutral-100 text-neutral-100" : "border-neutral-700 text-neutral-400"}`}
          >
            Custom
          </button>
        </div>
        {c.rangePreset === "custom" && (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <input
              aria-label="Minimum price"
              className="rounded-xl border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
              value={c.minPrice}
              onChange={(event) => c.setMinPrice(event.target.value)}
              placeholder="Min"
            />
            <input
              aria-label="Maximum price"
              className="rounded-xl border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
              value={c.maxPrice}
              onChange={(event) => c.setMaxPrice(event.target.value)}
              placeholder="Max"
            />
          </div>
        )}

        {quote && (
          <div className="mt-4 rounded-xl border border-neutral-800/60 bg-neutral-900/40 p-3 text-xs text-neutral-300">
            <dl className="space-y-2">
              <div className="flex justify-between gap-3"><FieldLabel label="Token A" /><dd>{formatAmount(quote.minOutA, quote.decimalsA)} {tokenSymbol(quote.mintA, undefined, quote.symbolA ?? pair.symbolA)}</dd></div>
              <div className="flex justify-between gap-3"><FieldLabel label="Token B" /><dd>{formatAmount(quote.minOutB, quote.decimalsB)} {tokenSymbol(quote.mintB, undefined, quote.symbolB ?? pair.symbolB)}</dd></div>
              <div className="flex justify-between gap-3"><FieldLabel label="Aligned range" /><dd>{formatPositionPriceRange(quote)}</dd></div>
              <div className="flex justify-between gap-3"><FieldLabel label="Status" /><dd>{formatRangeStatus(quote.rangeSide) ?? "—"}</dd></div>
              <div className="flex justify-between gap-3"><FieldLabel label="Price impact cap" /><dd>≤ {quote.maxImpactBps / 100}%</dd></div>
            </dl>
            <details className="group mt-3 border-t border-neutral-800 pt-3">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded text-neutral-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400 [&::-webkit-details-marker]:hidden">
                <span>Fees &amp; details</span>
                <span className="inline-flex items-center gap-2 text-neutral-300">
                  <span>~{lamports(upfrontCost)} upfront</span>
                  <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden="true" />
                </span>
              </summary>
              <dl className="mt-3 space-y-2">
                <div className="flex justify-between gap-3"><FieldLabel label="Quote validity" /><dd>{c.fresh ? `${Math.max(0, Math.ceil((quote.expiresAt - c.now) / 1000))} seconds remaining` : "Expired"}</dd></div>
                <div className="flex justify-between gap-3"><FieldLabel label="Refundable rent (NFT)" /><dd>{lamports(quote.rent.refundableLamports)}</dd></div>
                <div className="flex justify-between gap-3"><FieldLabel label="Non-refundable rent" /><dd>{lamports(quote.rent.nonRefundableLamports)}</dd></div>
                <div className="flex justify-between gap-3"><FieldLabel label="Network fee (est.)" /><dd>{lamports(quote.networkFeeLamportsEstimate)}</dd></div>
                <div className="flex justify-between gap-3"><FieldLabel label="Wallet SOL" /><dd>{lamports(quote.solLamports)}</dd></div>
              </dl>
              <p className="mt-3 text-xs leading-5 text-neutral-500">Upfront costs include refundable account deposits, one-time account setup and the estimated network fee. These are separate from your investment. Quotes refresh every 3 seconds.</p>
              {detailWarnings.map(warning => <p key={warning} className="mt-2 text-xs leading-5 text-neutral-400">{explainTokenWarning(warning)}</p>)}
            </details>
          </div>
        )}
        <div className="mt-2 flex min-h-5 items-center gap-2 text-xs leading-5 text-neutral-500">
          {c.quoteLoading && <>
            <RefreshCw size={24} strokeWidth={2} className="preview-icon h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            <span>Fetching the best price on Jupiter</span>
          </>}
        </div>

        {quote && !quote.passesFloor && (
          <p role="status" className="mt-3 rounded-xl border border-amber-800/70 bg-amber-950/40 p-3 text-xs leading-5 text-amber-100">
            Immediate resale of this position would recover about {quote.achievedResaleBps === null ? "an unknown share" : `${(quote.achievedResaleBps / 100).toFixed(2)}%`} of your input
            {quote.achievedResaleBps === null ? "." : ` (about ${(Math.max(0, 10_000 - quote.achievedResaleBps) / 100).toFixed(2)}% round-trip loss).`}
            {" "}This does not block signing. Price impact, balances, quote expiry, and simulation still protect the transaction.
          </p>
        )}

        {(visibleWarnings.filter((warning) => warning !== quote?.warning).length > 0 || c.quoteError || c.error) && (
          <div className="mt-3 space-y-2 text-xs leading-5 text-neutral-400">
            {visibleWarnings.filter((warning) => warning !== quote?.warning).map(warning => <p key={warning}>{explainTokenWarning(warning)}</p>)}
            {c.quoteError && <p role="alert" className="text-red-400">{c.quoteError}</p>}
            {c.error && <p role="alert" className="text-red-400">{c.error}</p>}
          </div>
        )}

        <p className="mt-4 text-xs text-neutral-500" role="status">{status}</p>
        {c.canRefreshQuote && (c.quoteError || (quote && !c.fresh)) && (
          <button type="button" onClick={c.refreshQuote} disabled={c.quoteLoading}
            className="mt-2 rounded-xl border border-neutral-700 px-3 py-2 text-xs text-neutral-300 disabled:opacity-40">
            Refresh quote
          </button>
        )}

        {c.submitStage === "confirmed" ? (
          <div className="mt-3 space-y-2 text-sm">
            <a className="block text-neutral-200 underline" href={`https://solscan.io/tx/${c.signature}`} target="_blank" rel="noreferrer">
              View on Solscan
            </a>
            <a className="block text-neutral-200 underline" href="/app">
              Open in Positions{c.positionMint ? ` (${c.positionMint.slice(0, 4)}…${c.positionMint.slice(-4)})` : ""}
            </a>
          </div>
        ) : !c.connected ? (
          <button
            type="button"
            onClick={c.connect}
            className="mt-4 w-full rounded-xl border border-neutral-700 px-4 py-3 text-sm font-semibold text-neutral-100"
          >
            Connect wallet
          </button>
        ) : (
          <button
            type="button"
            disabled={c.actionDisabled}
            title={c.actionBlockedReason || undefined}
            onClick={() => void c.signAndSend()}
            className="mt-4 w-full rounded-xl border border-neutral-700 px-4 py-3 text-sm font-semibold text-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {c.busy ? (
              <span className="inline-flex items-center gap-2">
                <LoaderCircle className="h-4 w-4 animate-spin" />
                {status}
              </span>
            ) : "Sign"}
          </button>
        )}
      </div>
    </div>
  );
}

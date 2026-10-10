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
  "Total cost": "",
  "Refundable rent (NFT)": "Estimated account deposits for the position NFT, its token account and your personal position account. You can recover the corresponding deposits when the position and accounts are closed.",
  "Non-refundable rent": "Estimated one-time cost to create shared protocol-position or tick-array accounts. These accounts remain after your position closes, so this cost is not returned to you.",
  "Network fee (est.)": "Estimated Solana transaction fee, confirmed during preparation. It is separate from your investment and account deposits.",
  "Wallet SOL": "Your wallet's total SOL balance. Keep enough SOL to cover account deposits and network fees in addition to your investment.",
} as const;

function FieldLabel({ label, help }: { label: keyof typeof FIELD_HELP; help?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <dt className="relative flex items-center gap-1.5 text-smoke">
      {label}
      <button type="button" aria-label={`About ${label}`} aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
        onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}
        className="inline-flex shrink-0 rounded text-smoke hover:text-cream/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream/70">
        <Info size={24} strokeWidth={2} className="preview-icon h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open && <span id={id} role="tooltip" className="pointer-events-none absolute left-0 top-full z-20 mt-1 w-64 max-w-[75vw] rounded-lg border border-white/20 bg-char px-3 py-2 text-left text-xs font-normal leading-5 text-cream/90 shadow-xl">
        {help ?? FIELD_HELP[label]}
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
  const totalCostPercent = quote && BigInt(quote.requested) > 0n
    ? (Number(quote.roundtripCostInput) / Number(quote.requested) * 100).toFixed(2)
    : null;
  const inputSymbol = quote?.inputKind === "native" ? "SOL" : quote
    ? tokenSymbol(quote.inputMint, undefined, quote.inputMint === pair.mintA ? pair.symbolA : quote.inputMint === pair.mintB ? pair.symbolB : undefined)
    : "SOL";
  const totalCostHelp = `Estimated round-trip cost: about ${totalCostPercent ?? "—"}% (assuming you open the position, immediately withdraw, and swap back to ${inputSymbol}). This conservative estimate includes swap fees, price impact, and slippage tolerance. It does not block signing.`;
  const detailWarnings = quote?.warnings.filter(isDetailWarning) ?? [];
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
      <button className="absolute inset-0 bg-black/70" aria-label="Close create position" onClick={onClose} />
      <div className="relative z-10 max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-[20px] border border-white/12 bg-char p-5 sm:rounded-[28px] sm:p-6">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id="open-position-title" className="text-base font-semibold text-cream">Create position</h2>
            <p className="mt-1 text-xs leading-5 text-smoke">{label}</p>
            <p className="mt-2 text-xs leading-5 text-smoke">Choose a wallet asset and price range. We swap into the pool tokens as needed, then create a new LP position and add liquidity in one transaction.</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-smoke hover:text-cream/90" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-4 flex flex-wrap gap-1">
          {(pair.token2022A || pair.token2022B) && (
            <span className="rounded-full border border-white/20 px-2 py-0.5 text-[10px] text-smoke">Token-2022</span>
          )}
          {pair.freezeRisk && (
            <span className="rounded-full border border-white/20 px-2 py-0.5 text-[10px] text-smoke">Freeze risk</span>
          )}
        </div>

        <label className="block text-xs text-smoke" htmlFor="open-input-asset">Input asset</label>
        <div className="relative mt-1">
          <select
            id="open-input-asset"
            className="w-full min-w-0 max-w-full appearance-none truncate rounded-2xl border border-white/20 bg-white/[0.06] py-2 pl-3 pr-12 text-sm text-cream"
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
          <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-cream" aria-hidden="true" />
        </div>

        <div className="mt-3 flex items-end gap-2">
          <div className="flex-1">
            <label className="block text-xs text-smoke" htmlFor="open-amount">Amount</label>
            <input
              id="open-amount"
              className="mt-1 w-full rounded-2xl border border-white/20 bg-white/[0.06] px-3 py-2 text-sm text-cream"
              value={c.amount}
              onChange={(event) => c.changeAmount(event.target.value)}
              inputMode="decimal"
              placeholder="0.0"
            />
          </div>
          <button
            className="rounded-full border border-white/20 px-3 py-2 text-xs font-semibold text-cream/80"
            onClick={c.fillMax}
            type="button"
          >
            Max
          </button>
        </div>

        <p className="mt-4 text-xs text-smoke">Price range (B per 1 A)</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {c.presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => c.choosePreset(preset.id)}
              className={`rounded-full border px-3 py-1 text-xs font-semibold ${c.rangePreset === preset.id ? "border-cream text-cream" : "border-white/20 text-smoke"}`}
            >
              {preset.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => c.choosePreset("custom")}
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${c.rangePreset === "custom" ? "border-cream text-cream" : "border-white/20 text-smoke"}`}
          >
            Custom
          </button>
        </div>
        {c.rangePreset === "custom" && (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <input
              aria-label="Minimum price"
              className="rounded-2xl border border-white/20 bg-white/[0.06] px-3 py-2 text-sm text-cream"
              value={c.minPrice}
              onChange={(event) => c.setMinPrice(event.target.value)}
              placeholder="Min"
            />
            <input
              aria-label="Maximum price"
              className="rounded-2xl border border-white/20 bg-white/[0.06] px-3 py-2 text-sm text-cream"
              value={c.maxPrice}
              onChange={(event) => c.setMaxPrice(event.target.value)}
              placeholder="Max"
            />
          </div>
        )}

        {quote && (
          <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-xs text-cream/80">
            <dl className="space-y-2">
              <div className="flex justify-between gap-3"><FieldLabel label="Token A" /><dd>{formatAmount(quote.minOutA, quote.decimalsA)} {tokenSymbol(quote.mintA, undefined, quote.symbolA ?? pair.symbolA)}</dd></div>
              <div className="flex justify-between gap-3"><FieldLabel label="Token B" /><dd>{formatAmount(quote.minOutB, quote.decimalsB)} {tokenSymbol(quote.mintB, undefined, quote.symbolB ?? pair.symbolB)}</dd></div>
              <div className="flex justify-between gap-3"><FieldLabel label="Aligned range" /><dd>{formatPositionPriceRange(quote)}</dd></div>
              <div className="flex justify-between gap-3"><FieldLabel label="Status" /><dd>{formatRangeStatus(quote.rangeSide) ?? "—"}</dd></div>
              <div className="flex justify-between gap-3"><FieldLabel label="Total cost" help={totalCostHelp} /><dd>{totalCostPercent === null ? "—" : `~${totalCostPercent}%`}</dd></div>
            </dl>
            <details className="group mt-3 border-t border-white/12 pt-3">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded text-smoke focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream/70 [&::-webkit-details-marker]:hidden">
                <span>Fees &amp; details</span>
                <span className="inline-flex items-center gap-2 text-cream/80">
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
              <p className="mt-3 text-xs leading-5 text-smoke">Upfront costs include refundable account deposits, one-time account setup and the estimated network fee. These are separate from your investment. Quotes refresh every 3 seconds.</p>
              {detailWarnings.map(warning => <p key={warning} className="mt-2 text-xs leading-5 text-smoke">{explainTokenWarning(warning)}</p>)}
            </details>
          </div>
        )}
        {c.quoteLoading && (
          <div role="status" className="mt-2 flex items-center gap-2 text-xs leading-5 text-smoke">
            <RefreshCw size={24} strokeWidth={2} className="preview-icon h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            <span>Fetching the best price on Jupiter</span>
          </div>
        )}

        {(c.quoteError || c.error) && (
          <div className="mt-3 space-y-2 text-xs leading-5 text-smoke">
            {c.quoteError && <p role="alert" className="text-coral">{c.quoteError}</p>}
            {c.error && <p role="alert" className="text-coral">{c.error}</p>}
          </div>
        )}

        {c.canRefreshQuote && (c.quoteError || (quote && !c.fresh)) && (
          <button type="button" onClick={c.refreshQuote} disabled={c.quoteLoading}
            className="mt-2 rounded-full border border-white/20 px-3 py-2 text-xs text-cream/80 disabled:opacity-40">
            Refresh quote
          </button>
        )}

        {c.submitStage === "confirmed" ? (
          <div className="mt-3 space-y-2 text-sm">
            <a className="block text-cream/90 underline" href={`https://solscan.io/tx/${c.signature}`} target="_blank" rel="noreferrer">
              View on Solscan
            </a>
            <a className="block text-cream/90 underline" href="/app">
              Open in Positions{c.positionMint ? ` (${c.positionMint.slice(0, 4)}…${c.positionMint.slice(-4)})` : ""}
            </a>
          </div>
        ) : !c.connected ? (
          <button
            type="button"
            onClick={c.connect}
            className="mt-4 w-full rounded-full bg-lemon px-5 py-3 text-sm font-semibold text-ink transition-colors hover:bg-[#fff27f]"
          >
            Connect wallet
          </button>
        ) : (
          <button
            type="button"
            disabled={c.actionDisabled}
            title={c.actionBlockedReason || undefined}
            onClick={() => void c.signAndSend()}
            className="mt-4 w-full rounded-full bg-lemon px-5 py-3 text-sm font-semibold text-ink transition-colors hover:bg-[#fff27f] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {c.busy ? (
              <span className="inline-flex items-center gap-2">
                <LoaderCircle className="h-4 w-4 animate-spin" />
                {status}
              </span>
            ) : "Create position"}
          </button>
        )}
      </div>
    </div>
  );
}

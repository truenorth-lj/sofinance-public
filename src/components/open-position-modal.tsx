"use client";

import { formatAmount } from "@/lib/amount";
import { formatPositionPriceRange, formatRangeStatus, tokenSymbol } from "@/lib/position-label";
import { LoaderCircle, X } from "lucide-react";
import { useOpenPositionController, type OpenPositionPair } from "./use-open-position-controller";

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
          <dl className="mt-4 space-y-2 rounded-xl border border-neutral-800/60 bg-neutral-900/40 p-3 text-xs text-neutral-300">
            <div className="flex justify-between gap-3"><dt className="text-neutral-500">Token A</dt><dd>{formatAmount(quote.minOutA, quote.decimalsA)} {tokenSymbol(quote.mintA, undefined, pair.symbolA)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-neutral-500">Token B</dt><dd>{formatAmount(quote.minOutB, quote.decimalsB)} {tokenSymbol(quote.mintB, undefined, pair.symbolB)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-neutral-500">Aligned range</dt><dd>{formatPositionPriceRange(quote)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-neutral-500">Status</dt><dd>{formatRangeStatus(quote.rangeSide) ?? "—"}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-neutral-500">Quote validity</dt><dd>{c.fresh ? `${Math.max(0, Math.ceil((quote.expiresAt - c.now) / 1000))} seconds remaining` : "Expired"}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-neutral-500">Price impact cap</dt><dd>≤ {quote.maxImpactBps / 100}%</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-neutral-500">Refundable rent (NFT)</dt><dd>{lamports(quote.rent.refundableLamports)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-neutral-500">Non-refundable rent</dt><dd>{lamports(quote.rent.nonRefundableLamports)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-neutral-500">Network fee (est.)</dt><dd>{lamports(quote.networkFeeLamportsEstimate)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-neutral-500">Wallet SOL</dt><dd>{lamports(quote.solLamports)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-neutral-500">Resale floor</dt><dd>{quote.passesFloor ? `Meets ${(quote.floorBps / 100).toFixed(1)}%` : `Below ${(quote.floorBps / 100).toFixed(1)}%`}</dd></div>
          </dl>
        )}
        <p className="mt-2 text-xs leading-5 text-neutral-500">Quotes refresh every 3 seconds. {c.quoteLoading && quote ? "Updating quote…" : ""} SOL fees and rent are calculated separately.</p>

        {quote && !quote.passesFloor && quote.warning && (
          <p role="status" className="mt-3 rounded-xl border border-amber-800/70 bg-amber-950/40 p-3 text-xs leading-5 text-amber-100">
            {quote.warning}
          </p>
        )}

        {(quote?.warnings.length || c.quoteError || c.error) && (
          <div className="mt-3 space-y-2 text-xs leading-5 text-neutral-400">
            {quote?.warnings.filter((warning) => warning !== quote.warning).map((warning) => <p key={warning}>{warning}</p>)}
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

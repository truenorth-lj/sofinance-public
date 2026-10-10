"use client";

import { useId, useState } from "react";
import { formatAmount } from "@/lib/amount";
import { formatPositionPriceRange, formatRangeStatus, tokenSymbol } from "@/lib/position-label";
import { Info, LoaderCircle, X } from "lucide-react";
import { useOpenPositionController, type OpenPositionPair } from "./use-open-position-controller";

const FIELD_HELP = {
  "Token A": "換幣後可用於建立 LP 的 A 代幣保守數量。實際投入量可能較少，剩餘代幣會留在錢包。",
  "Token B": "換幣後可用於建立 LP 的 B 代幣保守數量。實際投入量可能較少，剩餘代幣會留在錢包。",
  "Aligned range": "配合池子允許的價格刻度調整後的實際區間，單位是每 1 個 A 對應多少 B，不是美元價格。",
  "Status": "In range 表示目前池子價格在所選區間內，部位可參與交易並分得手續費；離開區間後會暫停賺取交易手續費。",
  "Quote validity": "目前這份報價的剩餘有效時間。每 3 秒觸發更新；過期報價不能簽署，準備交易時也會取得最新報價。",
  "Price impact cap": "換幣造成的價格影響上限，超過就停止準備交易。它與交易滑價容忍度是不同的設定，也不是整筆 LP 的虧損上限。",
  "Refundable rent (NFT)": "建立部位 NFT、相關代幣帳戶與個人部位帳戶所需的預估租金押金。關閉部位並回收這些帳戶時，可取回相應押金。",
  "Non-refundable rent": "首次建立共用協議部位或價格刻度帳戶的預估一次性成本。這些共用帳戶不隨你的部位關閉，因此不退還給你。",
  "Network fee (est.)": "預估支付給 Solana 網路的交易費，實際金額在交易準備時確認。它與投入金額、帳戶租金分開計算。",
  "Wallet SOL": "錢包目前的 SOL 總餘額。除了投入金額，還需要保留 SOL 支付帳戶租金與網路費。",
} as const;

function FieldLabel({ label }: { label: keyof typeof FIELD_HELP }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <dt className="relative flex items-center gap-1.5 text-neutral-500" onMouseEnter={() => setOpen(true)} onMouseLeave={(event) => { if (!event.currentTarget.contains(document.activeElement)) setOpen(false); }}>
      {label}
      <button type="button" aria-label={`${label} 說明`} aria-describedby={open ? id : undefined}
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
    return "此池的一種或兩種代幣使用 Token-2022 標準，可提供額外代幣功能。系統會阻擋目前收取轉帳費、暫停或已凍結的資產；但發行方仍可能保留日後凍結帳戶的權限。";
  }
  if (warning.startsWith("A pool mint has a freeze authority.")) {
    return "發行方仍保有凍結權限：日後可以凍結持有此代幣的帳戶，使其無法轉出或交易。若池子的相關帳戶被凍結，也可能影響加入或退出 LP。這項提醒不表示帳戶目前已被凍結。";
  }
  return warning;
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
            <div className="flex justify-between gap-3"><FieldLabel label="Token A" /><dd>{formatAmount(quote.minOutA, quote.decimalsA)} {tokenSymbol(quote.mintA, undefined, pair.symbolA)}</dd></div>
            <div className="flex justify-between gap-3"><FieldLabel label="Token B" /><dd>{formatAmount(quote.minOutB, quote.decimalsB)} {tokenSymbol(quote.mintB, undefined, pair.symbolB)}</dd></div>
            <div className="flex justify-between gap-3"><FieldLabel label="Aligned range" /><dd>{formatPositionPriceRange(quote)}</dd></div>
            <div className="flex justify-between gap-3"><FieldLabel label="Status" /><dd>{formatRangeStatus(quote.rangeSide) ?? "—"}</dd></div>
            <div className="flex justify-between gap-3"><FieldLabel label="Quote validity" /><dd>{c.fresh ? `${Math.max(0, Math.ceil((quote.expiresAt - c.now) / 1000))} seconds remaining` : "Expired"}</dd></div>
            <div className="flex justify-between gap-3"><FieldLabel label="Price impact cap" /><dd>≤ {quote.maxImpactBps / 100}%</dd></div>
            <div className="flex justify-between gap-3"><FieldLabel label="Refundable rent (NFT)" /><dd>{lamports(quote.rent.refundableLamports)}</dd></div>
            <div className="flex justify-between gap-3"><FieldLabel label="Non-refundable rent" /><dd>{lamports(quote.rent.nonRefundableLamports)}</dd></div>
            <div className="flex justify-between gap-3"><FieldLabel label="Network fee (est.)" /><dd>{lamports(quote.networkFeeLamportsEstimate)}</dd></div>
            <div className="flex justify-between gap-3"><FieldLabel label="Wallet SOL" /><dd>{lamports(quote.solLamports)}</dd></div>
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
            {quote?.warnings.filter((warning) => warning !== quote.warning).map((warning) => <p key={warning}>{explainTokenWarning(warning)}</p>)}
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

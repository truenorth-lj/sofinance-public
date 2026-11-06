"use client";

/**
 * Buy a stock token with USDC (homepage). Amount → read-only quote (`/api/spot-swap-quote`, through the browser relay):
 * issuer and short mint and quoted amount up front, plus one summary row (price impact · fee) that expands to our
 * 0.1% fee, minimum received, price impact (over 1% is refused with the
 * engine's words), the slippage limit, the one-time deposit for a new token account and the network fee, and SOL /
 * USDC checks. Buy → `spotSwapTxAdapter` through the shared pipeline: the user's wallet signs.
 */
import { ChevronRight, LoaderCircle, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createJupiterRelayStore } from "@/lib/jupiter/browser-relay";
import { formatPriceImpact, formatSol, formatTokenRaw, formatUsdc, STOCK_NOTICE_TEXT } from "@/lib/stock-market/format";
import { parseSpotSwapAmount, SPOT_SWAP_MAX_USDC, type StockBuyOption } from "@/lib/stock-market/public";
import { fetchSpotSwapQuote, spotSwapTxAdapter, type SpotSwapQuoteResult } from "@/lib/stock-market/spot-swap-client";
import { useTxPipeline } from "@/components/transactions/use-tx-pipeline";
import { BUTTON, FIELD, TxStatus } from "@/components/unified-positions/registry-tools";
import { useWalletConnection } from "@/components/wallet-connection";

const QUOTE_DEBOUNCE_MS = 500;
const ROW = "flex items-start justify-between gap-3";
/** Price impact (fraction) from which the summary row turns warning-coloured; over 1% is refused outright. */
const HIGH_IMPACT = 0.005;

export const DEPOSIT_COPY = "A one-time deposit opens the token account in your wallet. You get it back if you close that account later.";
export const SOL_LOW_COPY = (need: string, have: string) =>
  `Not enough SOL: this purchase needs about ${need} for the deposit and network fee, and your wallet has ${have}. Add SOL and try again.`;

type QuoteState = { key: string; value?: SpotSwapQuoteResult; error?: string; refused?: boolean };

export function amountProblem(amount: string): string | null {
  const trimmed = amount.trim();
  if (!trimmed) return null;
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === ".") return "Enter a number, for example 25.";
  if (/\.\d{7,}$/.test(trimmed)) return "USDC has at most 6 decimals.";
  const number = Number(trimmed);
  if (!(number > 0)) return "Enter an amount above zero.";
  if (number > SPOT_SWAP_MAX_USDC) return "Enter a smaller amount.";
  return null;
}

export function SpotSwapModal({ option, onClose }: { option: StockBuyOption; onClose: () => void }) {
  const { address: wallet, connected, connect, signTransaction, signAndSendTransaction } = useWalletConnection();
  const txWallet = useMemo(() => (wallet ? { address: wallet, signTransaction, signAndSendTransaction } : null), [wallet, signTransaction, signAndSendTransaction]);
  const tx = useTxPipeline(spotSwapTxAdapter, txWallet, { scope: `buy:${option.mint}`, inlineErrors: true });
  const relayStore = useRef(createJupiterRelayStore());
  const [amount, setAmount] = useState("");
  const problem = amountProblem(amount);
  const parsed = problem ? null : parseSpotSwapAmount(amount);
  const key = parsed ? `${option.underlying}:${parsed}:${wallet ?? ""}` : "";
  const [quote, setQuote] = useState<QuoteState | null>(null);

  useEffect(() => {
    if (!key || !parsed || tx.locked) return;
    const aborter = new AbortController();
    const timer = window.setTimeout(() => {
      setQuote({ key });
      fetchSpotSwapQuote({ underlying: option.underlying, amount: parsed, wallet: wallet ?? null, store: relayStore.current, signal: aborter.signal })
        .then((value) => setQuote({ key, value }))
        .catch((error: unknown) => {
          if (aborter.signal.aborted) return;
          const code = (error as { code?: string | null }).code;
          setQuote({ key, error: error instanceof Error ? error.message : "We couldn't get a price right now. Please try again in a moment.", refused: code === "spot_swap_price_impact" });
        });
    }, QUOTE_DEBOUNCE_MS);
    return () => { aborter.abort(); window.clearTimeout(timer); };
  }, [key, parsed, option.underlying, wallet, tx.locked]);

  const [expanded, setExpanded] = useState(false);
  const current = quote && quote.key === key ? quote : null;
  const quoted = current?.value?.quote ?? null;
  const check = current?.value?.wallet ?? null;
  const solLow = Boolean(check && !check.solSufficient);
  const usdcLow = Boolean(check && !check.usdcSufficient);
  const ready = Boolean(connected && quoted && parsed && check && !solLow && !usdcLow && !tx.locked && tx.status !== "success");
  const busy = tx.locked;
  const close = () => { if (!tx.closeLocked) onClose(); };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !tx.closeLocked) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, tx.closeLocked]);

  const submit = async () => {
    if (!quoted || !parsed) return;
    await tx.run({ underlying: option.underlying, mint: quoted.outputMint, amount: parsed, store: relayStore.current });
  };

  const symbol = quoted?.outputSymbol ?? option.symbol;
  const rentLamports = quoted ? BigInt(quoted.newAccountRentLamports) : 0n;
  const networkLamports = quoted ? BigInt(quoted.baseNetworkFeeLamports) : 0n;
  const needsDeposit = check ? !check.outputAccountExists : true;
  const highImpact = quoted ? Number(quoted.priceImpactPct) >= HIGH_IMPACT : false;

  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center" data-testid="spot-swap-modal" onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="spot-swap-heading"
      className="max-h-[100dvh] w-full overflow-y-auto rounded-t-[28px] border border-white/12 bg-char p-5 text-cream sm:max-w-md sm:rounded-[28px] sm:p-7">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="spot-swap-heading" className="text-lg font-semibold">Buy {option.company}</h2>
          <p className="mt-1 text-sm text-smoke" data-testid="spot-swap-issuer">{quoted?.issuerName ?? option.issuerName} · {quoted?.outputMintShort ?? option.mintShort}</p>
        </div>
        <button type="button" aria-label="Close" disabled={tx.closeLocked} onClick={close} className="rounded-full p-2 text-cream/80 hover:text-cream disabled:opacity-40"><X className="size-5" aria-hidden="true" /></button>
      </div>

      <label htmlFor="spot-swap-amount" className="mt-5 block text-xs font-medium uppercase tracking-[0.16em] text-smoke">You pay (USDC)</label>
      <input id="spot-swap-amount" data-testid="spot-swap-amount" disabled={busy} inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount}
        onChange={(event) => setAmount(event.target.value)} className={`mt-2 ${FIELD}`} />
      {problem ? <p role="alert" className="mt-2 text-xs text-cream/80">{problem}</p> : null}

      <div className="mt-4 space-y-2 rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-sm text-cream/80" data-testid="spot-swap-quote">
        {!parsed ? <p className="text-smoke">Enter an amount to see the price.</p> : null}
        {parsed && current && !current.value && !current.error ? <p role="status" className="flex items-center gap-2"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Getting a price…</p> : null}
        {current?.error ? <p role="alert" data-testid={current.refused ? "spot-swap-refused" : "spot-swap-quote-error"}>{current.error}</p> : null}
        {quoted ? <>
          <p className={ROW}><span>You receive (quoted)</span><span className="text-right font-data text-cream" data-testid="spot-swap-quoted">{formatTokenRaw(quoted.quotedOut, quoted.outputDecimals, symbol)}</span></p>
          <button type="button" aria-expanded={expanded} aria-controls="spot-swap-details" onClick={() => setExpanded((value) => !value)} data-testid="spot-swap-summary"
            data-high-impact={highImpact ? "true" : undefined}
            className={`flex w-full items-center justify-between gap-2 rounded-xl py-1 text-left text-xs outline-none focus-visible:shadow-[0_0_0_2px_var(--color-lilac)] ${highImpact ? "text-[#ffb86b]" : "text-smoke hover:text-cream"}`}>
            <span>Price impact {formatPriceImpact(quoted.priceImpactPct)} · Fee {(quoted.feeBps / 100).toFixed(1)}%</span>
            <ChevronRight aria-hidden="true" className={`size-4 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
            <span className="sr-only">{expanded ? "Hide details" : "Show details"}</span>
          </button>
          {expanded ? <div id="spot-swap-details" data-testid="spot-swap-details" className="space-y-2 border-t border-white/10 pt-2">
            <p className={ROW}><span>Minimum received</span><span className="text-right font-data" data-testid="spot-swap-min">{formatTokenRaw(quoted.minOut, quoted.outputDecimals, symbol)}</span></p>
            <p className={ROW}><span>Slippage limit</span><span className="text-right font-data">{(quoted.slippageBps / 100).toFixed(1)}%</span></p>
            <p className={ROW}><span>SoFinance fee (0.1%)</span><span className="text-right font-data" data-testid="spot-swap-fee">{formatUsdc(quoted.feeAmount)}</span></p>
            <p className="text-xs text-smoke">Included in the amount you pay.</p>
            {needsDeposit ? <p className={ROW}><span>Token account deposit (refundable)</span><span className="text-right font-data" data-testid="spot-swap-deposit">~{formatSol(rentLamports)}</span></p> : null}
            {needsDeposit ? <p className="text-xs text-smoke">{DEPOSIT_COPY}</p> : null}
            <p className={ROW}><span>Network fee</span><span className="text-right font-data">~{formatSol(networkLamports)}</span></p>
            <p className="text-xs text-smoke">Your wallet may add a small priority fee.</p>
          </div> : null}
        </> : null}
        {solLow && check ? <p role="alert" data-testid="spot-swap-sol-low">{SOL_LOW_COPY(formatSol(check.requiredLamports), formatSol(check.walletLamports))}</p> : null}
        {usdcLow && check ? <p role="alert" data-testid="spot-swap-usdc-low">Not enough USDC: your wallet has {formatUsdc(check.usdcBalance)}.</p> : null}
      </div>

      <p className="mt-3 text-[11px] leading-4 text-smoke" data-testid="spot-swap-notice">{STOCK_NOTICE_TEXT}</p>

      {!connected ? <button type="button" onClick={connect} className={BUTTON} data-testid="spot-swap-connect">Connect wallet to buy</button>
        : <button type="button" disabled={!ready} onClick={() => void submit()} className={BUTTON} data-testid="spot-swap-submit">
          {busy ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}Buy {symbol}
        </button>}
      <TxStatus tx={tx} successText={`Bought ${symbol}. It shows in your wallet.`} />
    </section>
  </div>;
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, Search } from "lucide-react";
import { useWalletConnection } from "./wallet-connection";
import {
  parseListedPositions,
  resolveWalletField,
  showUseConnectedWallet,
  type ListedPosition,
} from "../lib/position-performance-form";
import { PositionSelect } from "./position-select";
import { useTokenMetadata } from "./use-token-metadata";
import { DecisionSession } from "@/lib/lp-decision-session";
import { LpPositionEvidence } from "./lp-position-evidence";
import { PoolDailyAprChart } from "./pool-daily-apr-panel";
import { PoolActivityPanel } from "./pool-activity-panel";

type UiSide = { a: number; b: number };

type TokenEquivalent = {
  baseSymbol: string;
  baseSide: "A" | "B";
  wrappedSymbol: string | null;
  tickUsed: number;
  uiPriceBPerA: number;
  basis: string;
  note: string;
  metrics: {
    deposited: number;
    equity: number;
    liquidity: number;
    feesEarned: number;
    withdrawnPrincipal: number;
    pnl: number;
    holdingPeriodReturnPct: number | null;
    annualizedReturnPct: number | null;
    feeOnlyAprPct: number | null;
  };
};

type TokenNative = {
  symbolA: string | null;
  symbolB: string | null;
  sameAssetWrap: boolean;
  wrapKind: string | null;
  amounts: {
    deposited: UiSide;
    currentEquity: UiSide;
    feesEarned: UiSide;
    liquidityAmounts: UiSide;
    uncollectedFees: UiSide;
    feesCollected: UiSide;
    withdrawnPrincipal: UiSide;
    pnl: UiSide;
  };
  perSideFeeAprPct: { a: number | null; b: number | null };
  tokenEquivalent: TokenEquivalent | null;
};

type Metrics = {
  holdingDays: number | null;
  depositedUsd: number | null;
  currentEquityUsd: number | null;
  feesEarnedUsd: number | null;
  pnlUsd: number | null;
  holdingPeriodReturnPct: number | null;
  annualizedReturnPct: number | null;
  feeOnlyAprPct: number | null;
  depositedRaw: { a: string; b: string };
  currentEquityRaw: { a: string; b: string };
  feesEarnedRaw: { a: string; b: string };
  uncollectedFeesRaw: { a: string; b: string };
  feesCollectedRaw: { a: string; b: string };
};

type PerformanceResponse = {
  positionMint: string;
  poolId: string;
  mintA: string;
  mintB: string;
  decimalsA: number;
  decimalsB: number;
  tickLower?: number;
  tickUpper?: number;
  tickCurrent: number;
  rangeSide: string;
  liquidity: string;
  openedAtIso: string | null;
  evaluatedAtIso: string;
  truncated: boolean;
  signatureCount: number;
  ownsNft: boolean | null;
  cashflows: {
    openCount: number;
    increaseCount: number;
    decreaseCount: number;
  };
  metrics: Metrics;
  tokenNative?: TokenNative;
  pricing: { source: string; label: string; priceUsdA: number | null; priceUsdB: number | null };
  assumptions: string;
  method: string;
  realizedFeeAprSeries?: {
    label: string;
    assumptions: string;
    points: Array<{ time: number; date: string; aprPct: number | null; kind: string }>;
  };
  historyFetch?: {
    txCount: number;
    elapsedMs: number;
    provider: "solami" | "default" | "solami+default";
    source?: string;
    solamiTxCount?: number;
    defaultTxCount?: number;
    fallbackReasons?: string[];
  };
  error?: string;
};

const usedSolami = (provider: string | undefined) => provider === "solami" || provider === "solami+default";

export function formatHistoryFetch(metric: {
  txCount: number;
  elapsedMs: number;
  provider: string;
  source?: string;
}): string {
  if (metric.provider === "solami+default") {
    return `${metric.txCount} txs · ${metric.elapsedMs} ms · Solami for recent / fallback for older`;
  }
  const source = metric.source === "getTransactionsForAddress" ? "getTransactionsForAddress" : "batched";
  return `${metric.txCount} txs · ${metric.elapsedMs} ms · ${metric.provider} · ${source}`;
}

const pct = (value: number | null | undefined) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(2)}%`;
};

const money = (value: number | null | undefined) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `$${value.toFixed(4)}`;
};

const tok = (value: number | null | undefined, digits = 6) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toPrecision(digits);
};

const short = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;

const uiAmount = (raw: string, decimals: number) => {
  const value = Number(raw) / 10 ** decimals;
  if (!Number.isFinite(value)) return raw;
  return value.toPrecision(6);
};

export function PositionPerformancePanel({
  initialMint = "",
  initialWallet = "",
  previewPoolId = "",
}: {
  initialMint?: string;
  initialWallet?: string;
  previewPoolId?: string;
}) {
  const { address, connected } = useWalletConnection();
  const connectedAddress = connected ? address : undefined;
  const [positionMint, setPositionMint] = useState(initialMint);
  const [manualWallet, setManualWallet] = useState<string | null>(null);
  const [ignoreUrlWallet, setIgnoreUrlWallet] = useState(false);
  const [fetchedPositions, setFetchedPositions] = useState<{
    wallet: string;
    positions: ListedPosition[];
    status: "ready" | "error";
  } | null>(null);
  const [loadedData, setLoadedData] = useState<{ body: PerformanceResponse; context: string } | null>(null);
  const lookup = useRef(new DecisionSession());
  const [error, setError] = useState<string | null>(null);
  const [loadingContext, setLoadingContext] = useState<string | null>(null);
  const walletField = resolveWalletField({
    urlWallet: initialWallet,
    connectedAddress,
    manualValue: manualWallet,
    ignoreUrl: ignoreUrlWallet,
  });
  const wallet = walletField.value;
  const context = `${positionMint.trim()}:${wallet.trim()}`;
  const loading = loadingContext === context;
  const decisionMint = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(positionMint.trim()) ? positionMint.trim() : undefined;
  const data = loadedData?.context === context ? loadedData.body : null;
  useEffect(() => { const current = lookup.current; return () => current.cancel(); }, [context]);
  const changePositionMint = (value: string) => { lookup.current.cancel(); setLoadedData(null); setLoadingContext(null); setError(null); setPositionMint(value); };
  const listedPositions =
    fetchedPositions && fetchedPositions.wallet === connectedAddress ? fetchedPositions.positions : [];
  const positionMetadata = useTokenMetadata(listedPositions.flatMap((item) => [item.mintA, item.mintB]));
  const positionsStatus: "idle" | "loading" | "ready" | "error" = !connectedAddress
    ? "idle"
    : fetchedPositions && fetchedPositions.wallet === connectedAddress
      ? fetchedPositions.status
      : "loading";

  useEffect(() => {
    if (!connectedAddress) return;
    const aborter = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/wallet?wallet=${encodeURIComponent(connectedAddress)}`, {
            cache: "no-store",
            signal: aborter.signal,
            headers: { Accept: "application/json" },
          });
          const body: unknown = await response.json();
          if (!response.ok) throw new Error("Wallet scan failed");
          if (aborter.signal.aborted) return;
          setFetchedPositions({
            wallet: connectedAddress,
            positions: parseListedPositions(body),
            status: "ready",
          });
        } catch {
          if (!aborter.signal.aborted) {
            setFetchedPositions({ wallet: connectedAddress, positions: [], status: "error" });
          }
        }
      })();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      aborter.abort();
    };
  }, [connectedAddress]);

  const load = useCallback(async () => {
    const mint = positionMint.trim();
    if (!mint) {
      setError("Enter a position NFT mint");
      return;
    }
    const attempt = lookup.current.begin(); if (!attempt) return;
    setLoadingContext(context);
    setError(null);
    try {
      const params = new URLSearchParams({ positionMint: mint });
      if (wallet.trim()) params.set("wallet", wallet.trim());
      const response = await fetch(`/api/position-performance?${params}`, {
        signal: attempt.signal,
        headers: { Accept: "application/json" },
      });
      const body = (await response.json()) as PerformanceResponse & { error?: string };
      if (!attempt.current()) return;
      if (!response.ok) throw new Error(body.error || "Lookup failed");
      if (body.positionMint !== mint) throw new Error("Position response mismatch");
      setLoadedData({body, context});
    } catch (err) {
      if (attempt.current()) { setLoadedData(null); setError(err instanceof Error ? err.message : "Lookup failed"); }
    } finally {
      if (attempt.current()) { attempt.finish(); setLoadingContext(null); }
    }
  }, [context, positionMint, wallet]);

  const tn = data?.tokenNative;
  const te = tn?.tokenEquivalent ?? null;
  const symA = tn?.symbolA ?? "A";
  const symB = tn?.symbolB ?? "B";
  const preferTe = Boolean(te);

  return (
    <>
    <section className="rounded-[28px] border border-white/12 bg-char p-5 sm:p-7 lg:col-span-5" aria-labelledby="perf-heading">
      <h2 id="perf-heading" className="text-base font-semibold text-cream">
        Lookup by position NFT mint
      </h2>

      <div className="mt-4 space-y-3">
        <label className="block text-xs text-smoke">
          Position mint
          <input
            className="mt-1 w-full rounded-2xl border border-white/20 bg-white/[0.06] px-3 py-2 text-sm text-cream focus:border-white/40 focus:outline-none"
            value={positionMint}
            onChange={(event) => changePositionMint(event.target.value)}
            placeholder="Position NFT mint (base58)"
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <p className="text-[11px] leading-4 text-smoke/70">
          Paste any position NFT mint
          {connectedAddress ? ", or pick one from the connected wallet." : "."}
        </p>
        {connectedAddress && (
          <PositionSelect
            id="perf-position"
            label="Connected wallet positions"
            value={listedPositions.some((item) => item.positionMint === positionMint) ? positionMint : ""}
            disabled={positionsStatus !== "ready" || listedPositions.length === 0}
            onChange={(next) => {
              if (next) changePositionMint(next);
            }}
            positions={listedPositions}
            metadata={positionMetadata}
            placeholder={
              positionsStatus === "loading"
                ? "Loading positions…"
                : positionsStatus === "error"
                  ? "Could not load positions — paste a mint"
                  : listedPositions.length
                    ? "Select a position NFT"
                    : "No CLMM positions on this wallet"
            }
          />
        )}
        <div>
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="perf-wallet" className="text-xs text-smoke">
              Wallet (optional ownership check)
            </label>
            {showUseConnectedWallet(wallet, connectedAddress) && connectedAddress && (
              <button
                type="button"
                onClick={() => {
                  setManualWallet(null);
                  setIgnoreUrlWallet(true);
                }}
                className="text-[11px] font-medium text-smoke transition-colors hover:text-cream/80"
              >
                Use connected wallet
              </button>
            )}
          </div>
          <input
            id="perf-wallet"
            className="mt-1 w-full rounded-2xl border border-white/20 bg-white/[0.06] px-3 py-2 text-sm text-cream focus:border-white/40 focus:outline-none"
            value={wallet}
            onChange={(event) => setManualWallet(event.target.value)}
            placeholder="Defaults to the connected wallet"
            spellCheck={false}
            autoComplete="off"
          />
          <p className="mt-1 text-[11px] leading-4 text-smoke/70">
            Optional ownership check. Pre-filled from the connected wallet; clear or paste another
            pubkey to override.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-lemon px-5 py-3 text-sm font-semibold text-ink transition-colors hover:bg-[#fff27f] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          Compute performance
        </button>
      </div>

      {error && (
        <p className="mt-4 rounded-2xl border border-white/20 bg-white/[0.04] px-3 py-2 text-sm text-cream/80" role="alert">
          {error}
        </p>
      )}
    </section>

    {(data || previewPoolId) && (
    <section aria-label="Performance results" className="rounded-[28px] border border-white/12 bg-char p-5 sm:p-7 lg:col-span-12">
      {data && (
        <div className="space-y-5 text-sm">
          <div className="grid gap-3 sm:grid-cols-2">
            <Stat label="Holding days" value={data.metrics.holdingDays?.toFixed(2) ?? "—"} />
            <Stat label="Range" value={data.rangeSide} />
            {preferTe ? (
              <>
                <Stat
                  label={`Fee-only APR (TE · ${te!.baseSymbol})`}
                  value={pct(te!.metrics.feeOnlyAprPct)}
                  emphasize
                />
                <Stat
                  label={`Annualized return (TE · ${te!.baseSymbol})`}
                  value={pct(te!.metrics.annualizedReturnPct)}
                  emphasize
                />
                <Stat label={`HPR (TE · ${te!.baseSymbol})`} value={pct(te!.metrics.holdingPeriodReturnPct)} />
                <Stat label={`PnL (TE · ${te!.baseSymbol})`} value={`${tok(te!.metrics.pnl)} ${te!.baseSymbol}`} />
                <Stat
                  label={`Fees earned (TE · ${te!.baseSymbol})`}
                  value={`${tok(te!.metrics.feesEarned)} ${te!.baseSymbol}`}
                />
                <Stat
                  label={`Inventory / equity (TE · ${te!.baseSymbol})`}
                  value={`${tok(te!.metrics.equity)} ${te!.baseSymbol}`}
                />
                <Stat
                  label={`Deposited (TE · ${te!.baseSymbol})`}
                  value={`${tok(te!.metrics.deposited)} ${te!.baseSymbol}`}
                />
                <Stat
                  label="Events"
                  value={`open ${data.cashflows.openCount} · +liq ${data.cashflows.increaseCount} · −liq ${data.cashflows.decreaseCount}`}
                />
              </>
            ) : (
              <>
                <Stat label="HPR (USD)" value={pct(data.metrics.holdingPeriodReturnPct)} />
                <Stat label="Annualized return (USD)" value={pct(data.metrics.annualizedReturnPct)} />
                <Stat label="Fee-only APR (USD)" value={pct(data.metrics.feeOnlyAprPct)} emphasize />
                <Stat label="PnL (USD)" value={money(data.metrics.pnlUsd)} />
                <Stat label="Deposited (USD)" value={money(data.metrics.depositedUsd)} />
                <Stat label="Current equity (USD)" value={money(data.metrics.currentEquityUsd)} />
                <Stat label="Fees earned (USD)" value={money(data.metrics.feesEarnedUsd)} />
                <Stat
                  label="Events"
                  value={`open ${data.cashflows.openCount} · +liq ${data.cashflows.increaseCount} · −liq ${data.cashflows.decreaseCount}`}
                />
              </>
            )}
          </div>

          {tn && (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-smoke">
                Inventory (raw A / B){tn.sameAssetWrap ? " · same-asset wrap" : ""}
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2 text-xs text-cream/90">
                <div>
                  <div className="text-smoke">{symA} deposited → equity</div>
                  <div className="font-semibold text-cream">
                    {tok(tn.amounts.deposited.a)} → {tok(tn.amounts.currentEquity.a)}
                  </div>
                  <div className="text-smoke">
                    fees {tok(tn.amounts.feesEarned.a)} · side fee APR {pct(tn.perSideFeeAprPct.a)}
                  </div>
                </div>
                <div>
                  <div className="text-smoke">{symB} deposited → equity</div>
                  <div className="font-semibold text-cream">
                    {tok(tn.amounts.deposited.b)} → {tok(tn.amounts.currentEquity.b)}
                  </div>
                  <div className="text-smoke">
                    fees {tok(tn.amounts.feesEarned.b)} · side fee APR {pct(tn.perSideFeeAprPct.b)}
                  </div>
                </div>
              </div>
              {te && (
                <div className="mt-3 text-[11px] leading-5 text-smoke">
                  {te.basis}. Tick {te.tickUsed}; UI mid {te.uiPriceBPerA.toPrecision(8)} {symB}/{symA}.{" "}
                  {te.note}
                </div>
              )}
              <InventoryBar
                labelA={symA}
                labelB={symB}
                amountA={tn.amounts.currentEquity.a}
                amountB={tn.amounts.currentEquity.b}
                priceBPerA={te?.uiPriceBPerA ?? null}
              />
            </div>
          )}

          {preferTe && (
            <details className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-xs text-cream/80">
              <summary className="cursor-pointer text-smoke">USD (secondary · current prices)</summary>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <Stat label="HPR (USD)" value={pct(data.metrics.holdingPeriodReturnPct)} />
                <Stat label="Annualized (USD)" value={pct(data.metrics.annualizedReturnPct)} />
                <Stat label="Fee-only APR (USD)" value={pct(data.metrics.feeOnlyAprPct)} />
                <Stat label="PnL (USD)" value={money(data.metrics.pnlUsd)} />
                <Stat label="Deposited (USD)" value={money(data.metrics.depositedUsd)} />
                <Stat label="Equity (USD)" value={money(data.metrics.currentEquityUsd)} />
                <Stat label="Fees (USD)" value={money(data.metrics.feesEarnedUsd)} />
              </div>
            </details>
          )}

          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-xs text-cream/80">
            <div>
              Position {short(data.positionMint)} · pool {short(data.poolId)} · pair {symA}/{symB}
            </div>
            <div>Opened {data.openedAtIso ?? "—"} · evaluated {data.evaluatedAtIso}</div>
            {!tn && (
              <>
                <div>
                  Tokens A {uiAmount(data.metrics.depositedRaw.a, data.decimalsA)} deposited → equity{" "}
                  {uiAmount(data.metrics.currentEquityRaw.a, data.decimalsA)} (fees earned{" "}
                  {uiAmount(data.metrics.feesEarnedRaw.a, data.decimalsA)})
                </div>
                <div>
                  Tokens B {uiAmount(data.metrics.depositedRaw.b, data.decimalsB)} deposited → equity{" "}
                  {uiAmount(data.metrics.currentEquityRaw.b, data.decimalsB)} (fees earned{" "}
                  {uiAmount(data.metrics.feesEarnedRaw.b, data.decimalsB)})
                </div>
              </>
            )}
            {data.ownsNft !== null && <div>Owns NFT: {data.ownsNft ? "yes" : "no"}</div>}
            {data.historyFetch && (
              <div>
                History scan {formatHistoryFetch(data.historyFetch)}
                {usedSolami(data.historyFetch.provider) ? " · Powered by Solami" : ""}
              </div>
            )}
            {data.truncated && (
              <div className="font-medium text-cream/80">History truncated at signature cap — earlier txs may be missing.</div>
            )}
            <div className="mt-2 text-smoke">{data.pricing.label}</div>
            <div className="mt-1 text-smoke/70">{data.assumptions}</div>
            {usedSolami(data.historyFetch?.provider) && (
              <p className="mt-3 text-[10px] uppercase tracking-wide text-smoke/70">
                Powered by{" "}
                <a
                  href="https://solami.dev"
                  target="_blank"
                  rel="noreferrer"
                  className="text-smoke underline decoration-white/30 underline-offset-2 hover:text-cream/90"
                >
                  Solami
                </a>
              </p>
            )}
          </div>
        </div>
      )}

      {(data?.poolId || previewPoolId) && (
        <div className={data ? "mt-6" : undefined}>
          <PoolActivityPanel
            poolId={data?.poolId || previewPoolId}
            tickLower={data?.tickLower}
            tickUpper={data?.tickUpper}
            decimalsA={data?.decimalsA}
            decimalsB={data?.decimalsB}
            mintA={data?.mintA}
            mintB={data?.mintB}
          />
        </div>
      )}

      {(data?.poolId || previewPoolId) && (
        <div className="mt-6">
          <PoolDailyAprChart
            poolId={data?.poolId || previewPoolId}
            nowSeconds={
              data?.evaluatedAtIso
                ? Math.floor(new Date(data.evaluatedAtIso).getTime() / 1000) || undefined
                : undefined
            }
            overlay={
              data?.realizedFeeAprSeries
                ? {
                    label: data.realizedFeeAprSeries.label,
                    assumptions: data.realizedFeeAprSeries.assumptions,
                    points: data.realizedFeeAprSeries.points.map((point) => ({
                      time: point.time,
                      date: point.date,
                      value: point.aprPct,
                    })),
                  }
                : undefined
            }
          />
        </div>
      )}
    </section>
    )}
    {decisionMint && <LpPositionEvidence key={decisionMint} positionId={decisionMint} className="lg:col-span-12" />}
    </>
  );
}

function InventoryBar({
  labelA,
  labelB,
  amountA,
  amountB,
  priceBPerA,
}: {
  labelA: string;
  labelB: string;
  amountA: number;
  amountB: number;
  priceBPerA: number | null;
}) {
  const teA = priceBPerA && priceBPerA > 0 ? amountA + amountB / priceBPerA : null;
  const shareA =
    teA && teA > 0 && priceBPerA && priceBPerA > 0 ? Math.min(100, Math.max(0, (amountA / teA) * 100)) : 50;
  const shareB = 100 - shareA;
  return (
    <div className="mt-3">
      <div className="mb-1 flex justify-between text-[11px] text-smoke">
        <span>
          {labelA} {tok(amountA, 5)}
        </span>
        <span>
          {labelB} {tok(amountB, 5)}
        </span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-white/10" aria-hidden>
        <div className="bg-white/50" style={{ width: `${shareA}%` }} />
        <div className="bg-white/40" style={{ width: `${shareB}%` }} />
      </div>
      <div className="mt-1 text-[10px] text-smoke/70">
        Equity mix (TE-weighted when tick mid available)
      </div>
    </div>
  );
}

function Stat({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div
      className={`rounded-2xl border px-3 py-2 ${
        emphasize ? "border-white/20 bg-white/[0.07]" : "border-white/10 bg-white/[0.03]"
      }`}
    >
      <div className="text-[11px] font-medium uppercase tracking-wide text-smoke">{label}</div>
      <div className={`mt-1 font-semibold ${emphasize ? "text-cream" : "text-cream/90"}`}>{value}</div>
    </div>
  );
}

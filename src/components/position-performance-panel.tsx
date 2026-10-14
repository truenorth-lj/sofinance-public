"use client";

import { ConnectWalletPrompt } from "./connect-wallet-prompt";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, LoaderCircle, Search } from "lucide-react";
import { useWalletConnection } from "./wallet-connection";
import {
  parseListedPositions,
  resolveWalletField,
  showUseConnectedWallet,
  type ListedPosition,
} from "../lib/position-performance-form";
import { PositionSelect } from "./position-select";
import { PositionAssetRow } from "./position-asset-row";
import { useTokenMetadata } from "./use-token-metadata";
import { DecisionSession } from "@/lib/lp-decision-session";
import { PositionExitEstimate } from "./position-exit-estimate";
import { PoolDailyAprChart } from "./pool-daily-apr-panel";
import { PoolActivityPanel } from "./pool-activity-panel";
import { formatHoldingTime, returnUnavailableReason } from "../lib/position-performance-display";

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
    uncollectedFees: number;
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
  liquidityUsd: number | null;
  uncollectedFeesUsd: number | null;
  feesEarnedUsd: number | null;
  pnlUsd: number | null;
  holdingPeriodReturnPct: number | null;
  annualizedReturnPct: number | null;
  feeOnlyAprPct: number | null;
  depositedRaw: { a: string; b: string };
  currentEquityRaw: { a: string; b: string };
  liquidityAmountsRaw: { a: string; b: string };
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
    canContinue?: boolean;
  };
  error?: string;
};

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

export function PositionPerformancePanel({
  initialMint = "",
  initialWallet = "",
  previewPoolId = "",
  embedded = false,
  selectedMint,
  selectedNftAccount,
  nftAccountPending = false,
}: {
  initialMint?: string;
  initialWallet?: string;
  previewPoolId?: string;
  embedded?: boolean;
  selectedMint?: string;
  selectedNftAccount?: string;
  /** The parent is still resolving the holder's NFT token account (see resolveNftAccountLookup). */
  nftAccountPending?: boolean;
}) {
  const { address, connected, connect } = useWalletConnection();
  const connectedAddress = connected ? address : undefined;
  const [positionChoice, setPositionChoice] = useState<{ value: string; wallet: string | null; sharedMint?: string } | null>(
    initialMint ? { value: initialMint, wallet: null } : null,
  );
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
  const listedPositions =
    fetchedPositions && fetchedPositions.wallet === connectedAddress ? fetchedPositions.positions : [];
  const choiceIsCurrent = positionChoice && (positionChoice.wallet === null || positionChoice.wallet === connectedAddress)
    && (!embedded || positionChoice.sharedMint === selectedMint);
  const positionMint = choiceIsCurrent ? positionChoice.value : selectedMint ?? listedPositions[0]?.positionMint ?? "";
  const context = `${positionMint.trim()}:${wallet.trim()}`;
  const loading = loadingContext === context;
  const decisionMint = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(positionMint.trim()) ? positionMint.trim() : undefined;
  const data = loadedData?.context === context ? loadedData.body : null;
  const autoLoadSharedPosition = embedded && !choiceIsCurrent && Boolean(decisionMint) && positionMint === selectedMint;
  useEffect(() => { const current = lookup.current; return () => current.cancel(); }, [context]);
  const changePositionMint = (value: string) => {
    lookup.current.cancel();
    setLoadedData(null);
    setLoadingContext(null);
    setError(null);
    setPositionChoice({ value, wallet: connectedAddress ?? null, sharedMint: selectedMint });
  };
  const positionMetadata = useTokenMetadata([...listedPositions.flatMap((item) => [item.mintA, item.mintB]), ...(data ? [data.mintA, data.mintB] : [])]);
  const positionsStatus: "idle" | "loading" | "ready" | "error" = !connectedAddress
    ? "idle"
    : fetchedPositions && fetchedPositions.wallet === connectedAddress
      ? fetchedPositions.status
      : "loading";

  useEffect(() => {
    if (!connectedAddress || embedded) return;
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
  }, [connectedAddress, embedded]);

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
      // Continue bounded initial history loading as part of this view, without a scheduler.
      for (let step = 0; step < 5; step++) {
        const response = await fetch(`/api/position-performance?${params}`, {
          signal: attempt.signal,
          headers: { Accept: "application/json" },
        });
        const body = (await response.json()) as PerformanceResponse & { error?: string };
        if (!attempt.current()) return;
        if (!response.ok) throw new Error(body.error || "Lookup failed");
        if (body.positionMint !== mint) throw new Error("Position response mismatch");
        setLoadedData({body, context});
        if (!body.truncated || !body.historyFetch?.canContinue) break;
      }
    } catch (err) {
      if (attempt.current()) { setLoadedData(null); setError(err instanceof Error ? err.message : "Lookup failed"); }
    } finally {
      if (attempt.current()) { attempt.finish(); setLoadingContext(null); }
    }
  }, [context, positionMint, wallet]);

  useEffect(() => {
    if (!autoLoadSharedPosition) return;
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [autoLoadSharedPosition, load]);

  const tn = data?.tokenNative;
  const te = tn?.tokenEquivalent ?? null;
  const symA = tn?.symbolA ?? "A";
  const symB = tn?.symbolB ?? "B";
  const preferTe = Boolean(te);
  const holdingTime = formatHoldingTime(data?.metrics.holdingDays);
  const hasRecordedDeposits = Boolean(data && (Number(data.metrics.depositedRaw.a) > 0 || Number(data.metrics.depositedRaw.b) > 0));
  const missingReturn = (needsHoldingTime: boolean) => returnUnavailableReason({
    deposited: te ? te.metrics.deposited : data?.metrics.depositedUsd ?? null,
    holdingDays: data?.metrics.holdingDays ?? null,
    needsHoldingTime,
    missingUsdPrice: !te && Boolean(data && (data.pricing.priceUsdA === null || data.pricing.priceUsdB === null)),
    truncated: data?.truncated ?? false,
  });

  return (
    <>
    {!embedded && <section className="rounded-[28px] border border-white/12 bg-char p-5 sm:p-7 lg:col-span-5" aria-labelledby="perf-heading">
      <h2 id="perf-heading" className="text-base font-semibold text-cream">
        Step 1 · Select a position
      </h2>

      <div className="mt-4 space-y-3">
        {!embedded && connectedAddress && (
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
        {!embedded && !connectedAddress && <ConnectWalletPrompt onConnect={connect} />}
        {positionsStatus === "ready" && listedPositions.length === 0 && <div role="status" className="rounded-2xl border border-white/12 bg-white/[0.03] p-4">
          <p className="font-medium text-cream/90">No positions found in this wallet</p>
          <p className="mt-1 text-xs leading-5 text-smoke">Explore RWA pairs and open a position to start tracking performance.</p>
          <a href="/app/rwa-pairs" className="mt-3 inline-flex items-center gap-2 rounded-full border border-white/20 px-4 py-2 text-sm font-semibold text-cream hover:bg-white/10">Explore RWA Pairs <ArrowUpRight className="h-4 w-4" /></a>
        </div>}
        {!embedded && <details className="rounded-2xl border border-white/10 p-3">
          <summary className="cursor-pointer text-xs font-medium text-smoke">Look up another position by NFT mint</summary>
          <div className="mt-3 space-y-3">
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
          </div>
        </details>}
        {autoLoadSharedPosition && !error ? (
          (!data || loading) && <div role="status" className="flex items-center gap-2 border-t border-white/10 pt-5 text-sm text-smoke">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            Loading performance…
          </div>
        ) : <div className="border-t border-white/10 pt-5">
          {!embedded && <h3 className="text-base font-semibold text-cream">Step 2 · Compute performance</h3>}
          <p className="mb-3 mt-1 text-xs leading-5 text-smoke">Calculate returns and fees for the selected position.</p>
          <button
            type="button"
            onClick={() => { if (!connectedAddress && embedded) { connect(); return; } void load(); }}
            disabled={loading || (!(embedded && !connectedAddress) && !positionMint.trim())}
            className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-lemon px-5 py-3 text-sm font-semibold text-ink transition-colors hover:bg-[#fff27f] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            {autoLoadSharedPosition ? "Retry performance" : "Compute performance"}
          </button>
        </div>}
      </div>

      {error && (
        <p className="mt-4 rounded-2xl border border-white/20 bg-white/[0.04] px-3 py-2 text-sm text-cream/80" role="alert">
          {error}
        </p>
      )}
    </section>}

    {(embedded || data || previewPoolId) && (
    <section aria-label="Performance results" className="rounded-[28px] border border-white/12 bg-char p-5 sm:p-7 lg:col-span-12">
      <h3 className="mb-5 text-base font-semibold text-cream">Performance results</h3>
      {embedded && !data && !error && (
        autoLoadSharedPosition ? <div role="status" className="flex items-center gap-2 text-sm text-smoke">
          <LoaderCircle className="h-4 w-4 animate-spin" />Loading performance…
        </div> : <p className="text-sm text-smoke">{connectedAddress ? "Select a position above to view performance." : "Connect your wallet above to view performance."}</p>
      )}
      {embedded && error && <div className="space-y-3">
        <p role="alert" className="rounded-2xl border border-white/20 bg-white/[0.04] px-3 py-2 text-sm text-cream/80">{error}</p>
        <button type="button" onClick={() => void load()} disabled={loading}
          className="inline-flex items-center gap-2 rounded-full bg-lemon px-5 py-3 text-sm font-semibold text-ink disabled:opacity-40">
          {loading && <LoaderCircle className="h-4 w-4 animate-spin" />}Retry performance
        </button>
      </div>}

      {data && (
        <div className="space-y-5 text-sm" aria-live="polite">
          {!hasRecordedDeposits && <p role="status" className="rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-xs leading-5 text-cream/80">No deposit history was found. Current inventory is available, but trading-fee APR needs opening or deposit records.</p>}
          {te && <p className="text-xs leading-5 text-smoke">Amounts shown in {te.baseSymbol} equivalent.</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Stat label={holdingTime.label} value={holdingTime.value} description="Time since the earliest recorded position event." />
            <Stat label="Range" value={data.rangeSide === "inside" ? "In range" : data.rangeSide === "above" ? "Above range" : data.rangeSide === "below" ? "Below range" : data.rangeSide} />
            {preferTe ? (
              <>
                <Stat
                  label="Estimated trading-fee APR"
                  value={pct(te!.metrics.feeOnlyAprPct)}
                  description="Estimate: fees earned so far, annualized. Not a forecast or a promised return."
                  unavailableReason={missingReturn(true)}
                  emphasize
                  wide
                />
                <Stat
                  label={`Fees earned`}
                  value={`${tok(te!.metrics.feesEarned)} ${te!.baseSymbol}`}
                  description={`${data.metrics.feesEarnedUsd !== null ? `${money(data.metrics.feesEarnedUsd)} USD at current prices · ` : ""}Collected plus unclaimed fees.`}
                />
                <Stat
                  label={`Current position value (${te!.baseSymbol} equivalent)`}
                  value={`${tok(te!.metrics.equity)} ${te!.baseSymbol}`}
                  description={`${data.metrics.currentEquityUsd !== null ? `${money(data.metrics.currentEquityUsd)} USD · ` : ""}Liquidity ${tok(te!.metrics.liquidity)} + unclaimed fees ${tok(te!.metrics.uncollectedFees)} ${te!.baseSymbol}.`}
                />
              </>
            ) : (
              <>
                <Stat label="Estimated fee-only APR (USD)" value={pct(data.metrics.feeOnlyAprPct)} description="Estimate: fees earned so far, annualized. Not a forecast or a promised return." unavailableReason={missingReturn(true)} emphasize wide />
                <Stat label="Current equity (USD)" value={money(data.metrics.currentEquityUsd)}
                  description={data.metrics.liquidityUsd !== null && data.metrics.uncollectedFeesUsd !== null ? `Liquidity ${money(data.metrics.liquidityUsd)} + unclaimed fees ${money(data.metrics.uncollectedFeesUsd)}.` : "Liquidity plus unclaimed fees."} />
                <Stat label="Fees earned (USD)" value={money(data.metrics.feesEarnedUsd)} description="Collected plus unclaimed fees." />
              </>
            )}
          </div>

          <p className="text-xs leading-5 text-smoke">
            Estimated APR annualizes the trading fees earned so far (collected plus unclaimed) over recorded deposits and holding time, at current prices. Additional deposits are not time-weighted, and future fees can be higher or lower: it is not a promised return.
            {data.truncated && " Earlier transactions may be missing, so the estimate may be incomplete."}
          </p>
          {data.truncated && data.historyFetch?.canContinue && (
            <button type="button" disabled={Boolean(loadingContext)} onClick={() => void load()}
              className="rounded-xl border border-white/20 px-3 py-2 text-xs text-cream disabled:opacity-50">
              {loadingContext ? "Loading history…" : "Load remaining history"}
            </button>
          )}

          {!embedded && tn && (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
              <h4 className="text-[11px] font-semibold uppercase tracking-wide text-smoke">Position assets</h4>
              <div className="mt-4 divide-y divide-white/10">
                <PositionAssetRow symbol={symA} icon={positionMetadata[data.mintA]?.icon ?? null} decimals={data.decimalsA}
                  liquidityRaw={data.metrics.liquidityAmountsRaw.a} unclaimedFeesRaw={data.metrics.uncollectedFeesRaw.a} priceUsd={data.pricing.priceUsdA} />
                <PositionAssetRow symbol={symB} icon={positionMetadata[data.mintB]?.icon ?? null} decimals={data.decimalsB}
                  liquidityRaw={data.metrics.liquidityAmountsRaw.b} unclaimedFeesRaw={data.metrics.uncollectedFeesRaw.b} priceUsd={data.pricing.priceUsdB} />
              </div>
            </div>
          )}

        </div>
      )}


      {data && decisionMint && <PositionExitEstimate key={decisionMint} positionId={decisionMint} nftAccount={decisionMint === selectedMint ? selectedNftAccount : undefined}
        nftAccountPending={decisionMint === selectedMint && nftAccountPending} autoExit={embedded} className="mt-5" />}

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
    </>
  );
}

function Stat({ label, value, emphasize, wide, description, unavailableReason }: {
  label: string;
  value: string;
  emphasize?: boolean;
  /** Span both columns of the two-column grid so an odd card count leaves no hole. */
  wide?: boolean;
  description?: string;
  unavailableReason?: string;
}) {
  return (
    <div
      className={`rounded-2xl border px-3 py-2 ${wide ? "sm:col-span-2" : ""} ${
        emphasize ? "border-white/20 bg-white/[0.07]" : "border-white/10 bg-white/[0.03]"
      }`}
    >
      <div className="text-[11px] font-medium uppercase tracking-wide text-smoke">{label}</div>
      <div className={`mt-1 font-semibold ${emphasize ? "text-cream" : "text-cream/90"}`}>{value}</div>
      {description && <p className="mt-1 text-[11px] leading-4 text-smoke">{description}</p>}
      {value === "—" && unavailableReason && <p className="mt-2 text-[11px] leading-4 text-smoke">{unavailableReason}</p>}
    </div>
  );
}

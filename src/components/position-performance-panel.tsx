"use client";

import { useCallback, useEffect, useState } from "react";
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
import { PoolDailyAprChart } from "./pool-daily-apr-panel";

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
  error?: string;
};

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
  const [data, setData] = useState<PerformanceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const walletField = resolveWalletField({
    urlWallet: initialWallet,
    connectedAddress,
    manualValue: manualWallet,
    ignoreUrl: ignoreUrlWallet,
  });
  const wallet = walletField.value;
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
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ positionMint: mint });
      if (wallet.trim()) params.set("wallet", wallet.trim());
      const response = await fetch(`/api/position-performance?${params}`, {
        headers: { Accept: "application/json" },
      });
      const body = (await response.json()) as PerformanceResponse & { error?: string };
      if (!response.ok) throw new Error(body.error || "Lookup failed");
      setData(body);
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setLoading(false);
    }
  }, [positionMint, wallet]);

  const tn = data?.tokenNative;
  const te = tn?.tokenEquivalent ?? null;
  const symA = tn?.symbolA ?? "A";
  const symB = tn?.symbolB ?? "B";
  const preferTe = Boolean(te);

  return (
    <section className="rounded-[20px] border border-neutral-800/80 bg-[#0a0a0a] p-5 sm:p-7" aria-labelledby="perf-heading">
      <h2 id="perf-heading" className="text-base font-semibold text-neutral-100">
        Lookup by position NFT mint
      </h2>

      <div className="mt-4 space-y-3">
        <label className="block text-xs text-neutral-400">
          Position mint
          <input
            className="mt-1 w-full rounded-xl border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none"
            value={positionMint}
            onChange={(event) => setPositionMint(event.target.value)}
            placeholder="Position NFT mint (base58)"
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <p className="text-[11px] leading-4 text-neutral-600">
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
              if (next) setPositionMint(next);
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
            <label htmlFor="perf-wallet" className="text-xs text-neutral-400">
              Wallet (optional ownership check)
            </label>
            {showUseConnectedWallet(wallet, connectedAddress) && connectedAddress && (
              <button
                type="button"
                onClick={() => {
                  setManualWallet(null);
                  setIgnoreUrlWallet(true);
                }}
                className="text-[11px] font-medium text-neutral-500 transition-colors hover:text-neutral-300"
              >
                Use connected wallet
              </button>
            )}
          </div>
          <input
            id="perf-wallet"
            className="mt-1 w-full rounded-xl border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none"
            value={wallet}
            onChange={(event) => setManualWallet(event.target.value)}
            placeholder="Defaults to the connected wallet"
            spellCheck={false}
            autoComplete="off"
          />
          <p className="mt-1 text-[11px] leading-4 text-neutral-600">
            Optional ownership check. Pre-filled from the connected wallet; clear or paste another
            pubkey to override.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-neutral-700 bg-transparent px-4 py-3 text-sm font-semibold text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-900/50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          Compute performance
        </button>
      </div>

      {error && (
        <p className="mt-4 rounded-xl border border-neutral-700 bg-neutral-900/50 px-3 py-2 text-sm text-neutral-300" role="alert">
          {error}
        </p>
      )}

      {data && (
        <div className="mt-6 space-y-5 text-sm">
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
            <div className="rounded-xl border border-neutral-800/60 bg-neutral-900/30 p-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                Inventory (raw A / B){tn.sameAssetWrap ? " · same-asset wrap" : ""}
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2 text-xs text-neutral-200">
                <div>
                  <div className="text-neutral-500">{symA} deposited → equity</div>
                  <div className="font-semibold text-neutral-100">
                    {tok(tn.amounts.deposited.a)} → {tok(tn.amounts.currentEquity.a)}
                  </div>
                  <div className="text-neutral-400">
                    fees {tok(tn.amounts.feesEarned.a)} · side fee APR {pct(tn.perSideFeeAprPct.a)}
                  </div>
                </div>
                <div>
                  <div className="text-neutral-500">{symB} deposited → equity</div>
                  <div className="font-semibold text-neutral-100">
                    {tok(tn.amounts.deposited.b)} → {tok(tn.amounts.currentEquity.b)}
                  </div>
                  <div className="text-neutral-400">
                    fees {tok(tn.amounts.feesEarned.b)} · side fee APR {pct(tn.perSideFeeAprPct.b)}
                  </div>
                </div>
              </div>
              {te && (
                <div className="mt-3 text-[11px] leading-5 text-neutral-500">
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
            <details className="rounded-xl border border-neutral-800/40 bg-neutral-900/20 p-3 text-xs text-neutral-300">
              <summary className="cursor-pointer text-neutral-400">USD (secondary · current prices)</summary>
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

          <div className="rounded-xl border border-neutral-800/40 bg-neutral-900/20 p-3 text-xs text-neutral-300">
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
            {data.truncated && (
              <div className="font-medium text-neutral-300">History truncated at signature cap — earlier txs may be missing.</div>
            )}
            <div className="mt-2 text-neutral-500">{data.pricing.label}</div>
            <div className="mt-1 text-neutral-600">{data.assumptions}</div>
          </div>
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
      <div className="mb-1 flex justify-between text-[11px] text-neutral-400">
        <span>
          {labelA} {tok(amountA, 5)}
        </span>
        <span>
          {labelB} {tok(amountB, 5)}
        </span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-neutral-800" aria-hidden>
        <div className="bg-neutral-500" style={{ width: `${shareA}%` }} />
        <div className="bg-neutral-600" style={{ width: `${shareB}%` }} />
      </div>
      <div className="mt-1 text-[10px] text-neutral-600">
        Equity mix (TE-weighted when tick mid available)
      </div>
    </div>
  );
}

function Stat({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div
      className={`rounded-xl border px-3 py-2 ${
        emphasize ? "border-neutral-700 bg-neutral-800/50" : "border-neutral-800/40 bg-neutral-900/20"
      }`}
    >
      <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">{label}</div>
      <div className={`mt-1 font-semibold ${emphasize ? "text-neutral-100" : "text-neutral-200"}`}>{value}</div>
    </div>
  );
}

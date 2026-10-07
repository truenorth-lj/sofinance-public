"use client";

import { useCallback, useState } from "react";
import { LoaderCircle, Search } from "lucide-react";
import { Button } from "./ui/button";

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
  pricing: { source: string; label: string; priceUsdA: number | null; priceUsdB: number | null };
  assumptions: string;
  method: string;
  error?: string;
};

const pct = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(2)}%`;
};

const money = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return "—";
  return `$${value.toFixed(4)}`;
};

const short = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;

const uiAmount = (raw: string, decimals: number) => {
  const value = Number(raw) / 10 ** decimals;
  if (!Number.isFinite(value)) return raw;
  return value.toPrecision(6);
};

export function PositionPerformancePanel() {
  const [positionMint, setPositionMint] = useState("");
  const [wallet, setWallet] = useState("");
  const [data, setData] = useState<PerformanceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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

  return (
    <section className="rounded-2xl border border-white/10 bg-[#111d2c]/95 p-4 sm:p-5" aria-labelledby="perf-heading">
      <h2 id="perf-heading" className="text-sm font-semibold text-slate-100">
        Lookup by position NFT mint
      </h2>

      <div className="mt-4 space-y-3">
        <label className="block text-xs text-slate-400">
          Position mint
          <input
            className="mt-1 w-full rounded-xl border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100"
            value={positionMint}
            onChange={(event) => setPositionMint(event.target.value)}
            placeholder="Position NFT mint (base58)"
            spellCheck={false}
          />
        </label>
        <label className="block text-xs text-slate-400">
          Wallet (optional ownership check)
          <input
            className="mt-1 w-full rounded-xl border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100"
            value={wallet}
            onChange={(event) => setWallet(event.target.value)}
            placeholder="Wallet pubkey"
            spellCheck={false}
          />
        </label>
        <Button type="button" onClick={() => void load()} disabled={loading}>
          {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          Compute performance
        </Button>
      </div>

      {error && (
        <p className="mt-4 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200" role="alert">
          {error}
        </p>
      )}

      {data && (
        <div className="mt-6 space-y-4 text-sm">
          <div className="grid gap-3 sm:grid-cols-2">
            <Stat label="Holding days" value={data.metrics.holdingDays?.toFixed(2) ?? "—"} />
            <Stat label="Range" value={data.rangeSide} />
            <Stat label="HPR" value={pct(data.metrics.holdingPeriodReturnPct)} />
            <Stat label="Annualized return" value={pct(data.metrics.annualizedReturnPct)} />
            <Stat label="Fee-only APR" value={pct(data.metrics.feeOnlyAprPct)} />
            <Stat label="PnL (USD)" value={money(data.metrics.pnlUsd)} />
            <Stat label="Deposited (USD)" value={money(data.metrics.depositedUsd)} />
            <Stat label="Current equity (USD)" value={money(data.metrics.currentEquityUsd)} />
            <Stat label="Fees earned (USD)" value={money(data.metrics.feesEarnedUsd)} />
            <Stat
              label="Events"
              value={`open ${data.cashflows.openCount} · +liq ${data.cashflows.increaseCount} · −liq ${data.cashflows.decreaseCount}`}
            />
          </div>

          <div className="rounded-xl border border-white/10 bg-black/20 p-3 text-xs text-slate-300">
            <div>Position {short(data.positionMint)} · pool {short(data.poolId)}</div>
            <div>Opened {data.openedAtIso ?? "—"} · evaluated {data.evaluatedAtIso}</div>
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
            {data.ownsNft !== null && <div>Owns NFT: {data.ownsNft ? "yes" : "no"}</div>}
            {data.truncated && (
              <div className="text-amber-300">History truncated at signature cap — earlier txs may be missing.</div>
            )}
            <div className="mt-2 text-slate-400">{data.pricing.label}</div>
            <div className="mt-1 text-slate-500">{data.assumptions}</div>
          </div>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 font-semibold text-slate-100">{value}</div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { AprLineChart, AprSparkline, type AprChartSeries } from "./apr-chart";
import type { DailyAprPoint } from "../lib/apr-series";

export type PoolDailyAprResponse = {
  poolId: string;
  label: string;
  assumptions: string;
  feeRate: number | null;
  published: {
    dayFeeApr: number | null;
    weekFeeApr: number | null;
    monthFeeApr: number | null;
  };
  points: DailyAprPoint[];
  sources: string[];
  fetchedAt: string;
  error?: string;
};

export type OverlayAprPoint = {
  time: number;
  date: string;
  value: number | null;
};

async function loadPoolDailyApr(poolId: string, signal?: AbortSignal): Promise<PoolDailyAprResponse> {
  const response = await fetch(`/api/pool-daily-apr?poolId=${encodeURIComponent(poolId)}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  const body = (await response.json()) as PoolDailyAprResponse & { error?: string };
  if (!response.ok) throw new Error(body.error || "Failed to load pool daily APR");
  return body;
}

export function PoolDailyAprChart({
  poolId,
  overlay,
  nowSeconds,
}: {
  poolId: string;
  overlay?: { label: string; assumptions?: string; points: OverlayAprPoint[] };
  nowSeconds?: number;
}) {
  const [data, setData] = useState<PoolDailyAprResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetchedAtSeconds = data ? Math.floor(new Date(data.fetchedAt).getTime() / 1000) : 0;
  const evaluatedAt = nowSeconds ?? fetchedAtSeconds;

  useEffect(() => {
    const aborter = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const next = await loadPoolDailyApr(poolId, aborter.signal);
          if (!aborter.signal.aborted) {
            setData(next);
            setError(null);
          }
        } catch (err) {
          if (!aborter.signal.aborted) {
            setData(null);
            setError(err instanceof Error ? err.message : "Failed to load pool daily APR");
          }
        }
      })();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      aborter.abort();
    };
  }, [poolId]);

  const series: AprChartSeries[] = [];
  if (data) {
    series.push({
      id: "pool",
      label: data.label,
      stroke: "#e5e5e5",
      points: data.points.map((point) => ({ time: point.time, date: point.date, value: point.aprPct })),
    });
  }
  if (overlay && overlay.points.some((point) => point.value !== null)) {
    series.push({
      id: "position",
      label: overlay.label,
      stroke: "#a3a3a3",
      fillDots: true,
      points: overlay.points,
    });
  }

  const published = data
    ? [
        data.published.dayFeeApr !== null ? `Raydium 24h feeApr ${data.published.dayFeeApr.toFixed(2)}%` : null,
        data.published.weekFeeApr !== null ? `7d ${data.published.weekFeeApr.toFixed(2)}%` : null,
        data.published.monthFeeApr !== null ? `30d ${data.published.monthFeeApr.toFixed(2)}%` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <div className="space-y-2">
      {error && (
        <p className="rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-smoke" role="status">
          {error}
        </p>
      )}
      <AprLineChart
        title="Daily fee APR"
        subtitle={[
          data?.assumptions ?? "Estimated pool fee APR from public daily volume and TVL. Missing days are gaps.",
          overlay?.assumptions,
          published ? `Vendor windows (not the daily series): ${published}.` : null,
        ]
          .filter(Boolean)
          .join(" ")}
        series={series}
        nowSeconds={evaluatedAt}
        emptyLabel={data ? "No daily volume/TVL pair in this range." : "Loading pool daily APR…"}
      />
    </div>
  );
}

export function PoolAprSparkline({ poolId }: { poolId: string }) {
  const [data, setData] = useState<PoolDailyAprResponse | null>(null);

  useEffect(() => {
    const aborter = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const next = await loadPoolDailyApr(poolId, aborter.signal);
          if (!aborter.signal.aborted) setData(next);
        } catch {
          if (!aborter.signal.aborted) setData(null);
        }
      })();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      aborter.abort();
    };
  }, [poolId]);

  if (!data) {
    return <span className="text-[11px] text-smoke/70">…</span>;
  }
  return (
    <AprSparkline
      points={data.points.map((point) => ({ time: point.time, date: point.date, value: point.aprPct }))}
      nowSeconds={Math.floor(new Date(data.fetchedAt).getTime() / 1000)}
      label={data.label}
    />
  );
}

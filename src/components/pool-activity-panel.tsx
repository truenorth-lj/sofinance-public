"use client";

import { useEffect, useMemo, useState } from "react";
import { SolamiCredit } from "./solami-credit";
import { rangeStatusFromPrice, blurPriceToBPerA, type PositionRangeStatus } from "../lib/position-range-status";

type Trade = {
  signature: string;
  slot: number | null;
  blockTime: number | null;
  dex: string | null;
  pool: string | null;
  side: string | null;
  trader: string | null;
  price: number | null;
  priceUsd: number | null;
  volumeUsd: number | null;
  baseAmount: number | null;
  quoteAmount: number | null;
  type: string | null;
  ixIndex?: number | null;
  innerIxIndex?: number | null;
};

const tradeKey = (trade: Trade) => `${trade.signature}:${trade.ixIndex ?? ""}:${trade.innerIxIndex ?? ""}`;

type PoolSnap = {
  pool: string;
  dex: string | null;
  mint: string | null;
  quoteMint: string | null;
  name: string | null;
  symbol: string | null;
  price: number | null;
  priceUsd: number | null;
  tvlUsd: number | null;
  fees24hUsd: number | null;
  liquidityUsd: number | null;
};

type Snapshot = {
  available: boolean;
  poolId: string;
  pool: PoolSnap | null;
  trades: Trade[];
  fetchedAt: string;
  source: string;
};

const short = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;

const money = (value: number | null | undefined) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1000) return `$${value.toFixed(0)}`;
  return `$${value.toFixed(2)}`;
};

export function PoolActivityPanel({
  poolId,
  tickLower,
  tickUpper,
  decimalsA,
  decimalsB,
  mintA,
  mintB,
}: {
  poolId?: string;
  tickLower?: number;
  tickUpper?: number;
  decimalsA?: number;
  decimalsB?: number;
  mintA?: string;
  mintB?: string;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [live, setLive] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (!poolId) return;
    const aborter = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(`/api/pool-activity?poolId=${encodeURIComponent(poolId)}`, {
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: aborter.signal,
        });
        const body = (await response.json()) as Snapshot;
        if (!response.ok || !body.available) {
          setHidden(true);
          return;
        }
        setHidden(false);
        setSnapshot(body);
        setTrades(body.trades);
        const oriented = blurPriceToBPerA(
          body.pool?.price ?? null,
          body.pool?.mint ?? null,
          body.pool?.quoteMint ?? null,
          mintA ?? body.pool?.mint ?? "",
          mintB ?? body.pool?.quoteMint ?? "",
        );
        if (oriented) setLivePrice(oriented);
      } catch {
        if (!aborter.signal.aborted) setHidden(true);
      }
    };
    void load();
    const poll = window.setInterval(() => void load(), 20_000);
    return () => {
      aborter.abort();
      window.clearInterval(poll);
    };
  }, [poolId, mintA, mintB]);

  useEffect(() => {
    if (!poolId || hidden) return;
    let source: EventSource | null = null;
    let retry: number | undefined;
    const connect = () => {
      source = new EventSource(`/api/pool-activity/stream?poolId=${encodeURIComponent(poolId)}`);
      source.addEventListener("ready", () => setLive(true));
      source.addEventListener("swap", (event) => {
        try {
          const trade = JSON.parse((event as MessageEvent).data) as Trade;
          setTrades((current) => {
            if (current.some((item) => tradeKey(item) === tradeKey(trade))) return current;
            return [trade, ...current].slice(0, 20);
          });
          const oriented = blurPriceToBPerA(
            trade.price,
            snapshot?.pool?.mint ?? mintA ?? null,
            snapshot?.pool?.quoteMint ?? mintB ?? null,
            mintA ?? snapshot?.pool?.mint ?? "",
            mintB ?? snapshot?.pool?.quoteMint ?? "",
          );
          if (oriented) setLivePrice(oriented);
        } catch {
          /* ignore malformed frames */
        }
      });
      source.addEventListener("unavailable", () => {
        setLive(false);
        source?.close();
      });
      source.addEventListener("end", () => {
        setLive(false);
        source?.close();
        retry = window.setTimeout(connect, 1_200);
      });
      source.onerror = () => {
        setLive(false);
        source?.close();
        retry = window.setTimeout(connect, 2_500);
      };
    };
    connect();
    return () => {
      source?.close();
      if (retry) window.clearTimeout(retry);
    };
  }, [poolId, hidden, mintA, mintB, snapshot?.pool?.mint, snapshot?.pool?.quoteMint]);

  const range: PositionRangeStatus | null = useMemo(() => {
    if (
      livePrice === null ||
      tickLower === undefined ||
      tickUpper === undefined ||
      decimalsA === undefined ||
      decimalsB === undefined
    ) {
      return null;
    }
    try {
      return rangeStatusFromPrice({
        priceBPerA: livePrice,
        tickLower,
        tickUpper,
        decimalsA,
        decimalsB,
        priceSource: "solami-blur",
      });
    } catch {
      return null;
    }
  }, [livePrice, tickLower, tickUpper, decimalsA, decimalsB]);

  if (!poolId || hidden || !snapshot) return null;

  return (
    <section
      className="rounded-[20px] border border-neutral-800/80 bg-[#0a0a0a] p-5 sm:p-7"
      aria-labelledby="pool-activity-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="pool-activity-heading" className="text-base font-semibold text-neutral-100">
          Live pool activity
        </h2>
        <span className="text-[11px] text-neutral-500">{live ? "Live · Blur" : "Snapshot · Blur"}</span>
      </div>
      <p className="mt-1 text-xs leading-5 text-neutral-500">
        {snapshot.pool?.symbol ?? snapshot.pool?.name ?? short(poolId)} · decoded swaps from Solami Blur
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Stat label="Pool price" value={livePrice !== null ? livePrice.toPrecision(8) : "—"} />
        <Stat label="TVL" value={money(snapshot.pool?.tvlUsd ?? snapshot.pool?.liquidityUsd)} />
        <Stat label="Fees 24h" value={money(snapshot.pool?.fees24hUsd)} />
      </div>

      {range && (
        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
          <span
            className={`rounded-full border px-2.5 py-1 ${
              range.inRange
                ? "border-neutral-600 bg-neutral-800/50 text-neutral-200"
                : "border-neutral-700 bg-neutral-800/30 text-neutral-400"
            }`}
          >
            {range.inRange
              ? "In range"
              : range.rangeSide === "below"
                ? "Out of range · below"
                : "Out of range · above"}
          </span>
          {range.nearEdge && range.inRange && (
            <span className="rounded-full border border-neutral-600 px-2.5 py-1 text-neutral-300">
              Approaching {range.edge} edge
            </span>
          )}
          <span className="text-neutral-600">
            Band {range.priceLower.toPrecision(6)}–{range.priceUpper.toPrecision(6)}
          </span>
        </div>
      )}

      <ol className="mt-4 space-y-2" aria-label="Recent swaps">
        {trades.length === 0 && <li className="text-xs text-neutral-600">No recent swaps for this pool in the Blur window.</li>}
        {trades.slice(0, 12).map((trade) => (
          <li
            key={tradeKey(trade)}
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-neutral-800/50 bg-neutral-900/30 px-3 py-2 text-xs text-neutral-300"
          >
            <span className="font-medium uppercase tracking-wide text-neutral-400">{trade.side ?? "swap"}</span>
            <span>{trade.volumeUsd !== null ? money(trade.volumeUsd) : trade.price !== null ? trade.price.toPrecision(6) : "—"}</span>
            <a
              href={`https://solscan.io/tx/${trade.signature}`}
              target="_blank"
              rel="noreferrer"
              className="text-neutral-400 underline decoration-neutral-700 underline-offset-2 hover:text-neutral-200"
            >
              {short(trade.signature)}
            </a>
          </li>
        ))}
      </ol>
      <SolamiCredit className="mt-4" />
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-neutral-800/40 bg-neutral-900/20 px-3 py-2">
      <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 font-semibold text-neutral-200">{value}</div>
    </div>
  );
}

"use client";

/**
 * Performance tab, two or more positions: the totals across every stock held, then one row per stock (same-stock
 * positions merged) that opens in place into that stock's three tiles. Reports load one position at a time (each
 * reads that position's chain history), and rows appear as they arrive; totals wait for every position so a sum is
 * never partial. Positions in pools that are not same-stock pairs have no stock view and are left out.
 * The selected position is read by its own panel below; the overview takes that result (`fromPanel`) instead of
 * reading the same chain history a second time, and reads it itself only when Retry is pressed after a failure.
 */
import { ChevronDown, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import type { PositionPerformanceReport } from "@/lib/position-performance-report";
import { changeTone, formatChangePct, formatShares, formatShortDate, formatUsd } from "@/lib/stock-performance-format";
import { groupByStock, portfolioTotals, type StockRow } from "@/lib/stock-portfolio";
import { StockFootnote, StockPerformanceTiles, StockTile, StockTotalRow } from "./stock-performance-tiles";

type Loaded = { report: PositionPerformanceReport | null; error: boolean };

export type OverviewPosition = {
  key: string;
  pool?: { id: string; label: string; source: string };
  positionId?: string;
  load: (signal: AbortSignal) => Promise<PositionPerformanceReport | null>;
  /** Read by the selected position's panel: "loading" until it finishes, then its result. */
  fromPanel?: Loaded | "loading";
};

const CACHE_MS = 60_000;
/** Reports read in this tab, so leaving and reopening Performance does not re-read every position at once. */
const reportCache = new Map<string, { at: number; report: PositionPerformanceReport | null }>();

const toneClass = { up: "text-mint", down: "text-coral", flat: "text-smoke" } as const;

type PositionSelection = {
  selectedPositionKey?: string;
  onSelectPosition?: (key: string) => void;
  selectionDisabled?: boolean;
};

export function StocksOverview({ positions, selectedPositionKey, onSelectPosition, selectionDisabled }: { positions: OverviewPosition[] } & PositionSelection) {
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const [attempt, setAttempt] = useState(0);
  /** Panel-read positions whose read failed and the user pressed Retry: the overview reads them itself. */
  const [forced, setForced] = useState<ReadonlySet<string>>(() => new Set());
  const [open, setOpen] = useState<string | null>(null);
  const ownRead = (item: OverviewPosition) => !item.fromPanel || forced.has(item.key);
  const keys = positions.filter(ownRead).map((item) => item.key).join("|");
  const loaders = useRef(positions);
  useEffect(() => { loaders.current = positions; });

  useEffect(() => {
    const controller = new AbortController();
    const wanted = new Set(keys.split("|"));
    void (async () => {
      for (const item of loaders.current) {
        if (!wanted.has(item.key)) continue;
        if (controller.signal.aborted) return;
        const hit = reportCache.get(item.key);
        if (hit && Date.now() - hit.at < CACHE_MS) {
          setLoaded((current) => current[item.key]?.report === hit.report ? current : { ...current, [item.key]: { report: hit.report, error: false } });
          continue;
        }
        try {
          const report = await item.load(controller.signal);
          if (controller.signal.aborted) return;
          reportCache.set(item.key, { at: Date.now(), report });
          setLoaded((current) => ({ ...current, [item.key]: { report, error: false } }));
        } catch {
          if (controller.signal.aborted) return;
          setLoaded((current) => ({ ...current, [item.key]: { report: null, error: true } }));
        }
      }
    })();
    return () => controller.abort();
  }, [keys, attempt]);

  if (positions.length < 2) return null;
  const current = positions.map((item) => ({ key: item.key, position: item,
    state: ownRead(item) ? loaded[item.key] : item.fromPanel === "loading" ? undefined : item.fromPanel }));
  const pending = current.filter((item) => !item.state).length;
  const failed = current.filter((item) => item.state?.error).length;
  const rows = groupByStock(current.flatMap((item) => item.state?.report?.stock ? [{ key: item.key, stock: item.state.report.stock }] : []));
  const complete = pending === 0 && failed === 0;
  const totals = portfolioTotals(rows);
  const shown = (value: number | null) => complete ? value : null;
  if (!pending && !rows.length) return null;

  return <section aria-labelledby="stocks-overview-heading" data-testid="stocks-overview"
    className="rounded-[28px] border border-white/12 bg-char p-5 sm:p-7">
    <div className="mb-5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
      <h3 id="stocks-overview-heading" className="text-base font-semibold text-cream">All positions</h3>
      <div className="whitespace-nowrap text-[13px] tabular-nums tracking-[0.02em] text-smoke">Portfolio value
        <span className="ml-1.5 font-medium text-cream">{formatUsd(shown(totals.valueUsd))}</span>
        <span className="ml-1.5">· {rows.length} {rows.length === 1 ? "stock" : "stocks"}</span></div>
    </div>
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <StockTile testId="overview-tile-24h" label="Your stocks, 24h" value={formatUsd(shown(totals.change24hUsd), { signed: true })}
          change={complete ? formatChangePct(totals.change24hPct) : undefined} changeTone={changeTone(shown(totals.change24hPct))} aside="24h" />
        <StockTile testId="overview-tile-price" label="Price change since deposit" value={formatUsd(shown(totals.priceChangeUsd), { signed: true })}
          change={complete && totals.priceChangePct !== null ? formatChangePct(totals.priceChangePct) : undefined} changeTone={changeTone(shown(totals.priceChangePct))}
          aside={complete && totals.costUsd !== null ? `on ${formatUsd(totals.costUsd)}` : undefined} />
        <StockTile testId="overview-tile-fees" label="Earned from fees" value={formatUsd(shown(totals.feeUsd))}
          aside={`across ${rows.length} ${rows.length === 1 ? "stock" : "stocks"}`} />
      </div>
      {/* One slot for loading → total (or the failure line), so the stock list below does not jump when totals arrive. */}
      <div className="flex min-h-[58px] flex-col justify-center" data-testid="overview-total-slot">
      {complete && <StockTotalRow priceUsd={totals.priceChangeUsd} feeUsd={totals.feeUsd} totalUsd={totals.totalUsd} />}
      {pending > 0 && <p role="status" className="flex items-center gap-2 text-[13px] text-smoke">
        <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />
        Loading {positions.length - pending} of {positions.length} positions… Totals appear when every position is read.
      </p>}
      {!pending && failed > 0 && <p role="alert" className="flex flex-wrap items-center gap-3 text-[13px] text-smoke">
        {failed} {failed === 1 ? "position" : "positions"} could not be read, so totals are not shown.
        <button type="button" onClick={() => {
          for (const item of current) if (item.state?.error) reportCache.delete(item.key);
          setLoaded((state) => Object.fromEntries(Object.entries(state).filter(([, value]) => !value.error)));
          setForced((set) => new Set([...set, ...current.filter((item) => item.state?.error).map((item) => item.key)]));
          setAttempt((value) => value + 1);
        }} className="rounded-full border border-white/20 px-3 py-1 text-[13px] text-cream hover:bg-white/10">Retry</button>
      </p>}
      </div>
      {rows.length > 0 && <div className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]" data-testid="stock-rows">
        <div className="hidden grid-cols-[1.25fr_0.6fr_1fr_1fr_0.95fr_16px] gap-3 px-5 py-3 text-[12px] tracking-[0.02em] text-smoke sm:grid" aria-hidden="true">
          <span>Stock</span><span className="text-right">Shares</span><span className="text-right">Price change</span>
          <span className="text-right">From fees</span><span className="text-right">Value</span><span />
        </div>
        <div className="sm:border-t sm:border-white/10">
          {rows.map((row) => <StockRowItem key={row.symbol} row={row} open={open === row.symbol}
            selectedPositionKey={selectedPositionKey} onSelectPosition={onSelectPosition} selectionDisabled={selectionDisabled}
            positions={current.flatMap((item) => row.positionKeys.includes(item.key) && item.state?.report?.stock
              ? [{ position: item.position, report: item.state.report }] : [])}
            onToggle={() => setOpen((value) => value === row.symbol ? null : row.symbol)} />)}
        </div>
      </div>}
      <StockFootnote />
    </div>
  </section>;
}

type LoadedPosition = { position: OverviewPosition; report: PositionPerformanceReport };

const shortId = (id: string) => id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;

function StockPools({ positions, selectedPositionKey, onSelectPosition, selectionDisabled }: { positions: LoadedPosition[] } & PositionSelection) {
  const groups = new Map<string, { id: string; label: string; source: string; positions: LoadedPosition[] }>();
  for (const item of positions) {
    const { position, report } = item;
    const id = position.pool?.id ?? report.poolId ?? position.key;
    const source = position.pool?.source ?? "Unknown protocol";
    const label = position.pool?.label ?? (report.tokenNative?.symbolA && report.tokenNative.symbolB
      ? `${report.tokenNative.symbolA} / ${report.tokenNative.symbolB}` : "Pair unavailable");
    const key = JSON.stringify([source, id]);
    const group = groups.get(key) ?? { id, label, source, positions: [] };
    group.positions.push(item);
    groups.set(key, group);
  }
  return <div className="mt-3 space-y-3" aria-label="Pools and positions">
    {[...groups.entries()].map(([key, group]) => <section key={key} aria-label={`${group.source} · ${group.label} · ${group.id}`}
      data-testid="stock-pool-group" className="rounded-xl border border-white/10 p-3">
      <h4 className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-smoke">
        <span className="font-medium text-cream">{group.source} · {group.label}</span>
        <span>Pool <span title={group.id}>{shortId(group.id)}</span></span>
      </h4>
      <ul className="mt-3 space-y-3">
        {group.positions.map(({ position, report }) => {
          const id = position.positionId ?? report.positionMint ?? position.key;
          const selected = selectedPositionKey === position.key;
          const content = <>
            <span className="text-cream">Position <span title={id}>{shortId(id)}</span></span>
            <span className="flex flex-wrap gap-3 tabular-nums text-smoke">
              <span>Value {formatUsd(report.stock!.valueUsd)}</span><span>Fees {formatUsd(report.stock!.feeUsd)}</span>
              {selected && <span className="text-mint">Selected</span>}
            </span>
          </>;
          return <li key={position.key} data-testid="stock-position" className="flex flex-wrap items-center justify-between gap-3 text-[13px]">
            {onSelectPosition ? <button type="button" aria-pressed={selected} onClick={() => onSelectPosition(position.key)}
              disabled={selectionDisabled} data-testid="stock-position-select" data-position-key={position.key}
              className={cn("flex w-full flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-left transition-colors enabled:hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-mint disabled:cursor-not-allowed disabled:opacity-50",
                selected ? "border-mint/40 bg-mint/5" : "border-white/10")}>
              {content}
            </button> : content}
          </li>;
        })}
      </ul>
    </section>)}
  </div>;
}

function StockRowItem({ row, positions, open, onToggle, selectedPositionKey, onSelectPosition, selectionDisabled }: {
  row: StockRow; positions: LoadedPosition[]; open: boolean; onToggle: () => void;
} & PositionSelection) {
  const since = formatShortDate(row.firstDepositAtIso);
  const sub = row.positionKeys.length > 1 ? `${row.positionKeys.length} positions` : since ? `since ${since}` : "";
  const panelId = `stock-row-${row.symbol}`;
  return <div className="border-t border-white/10 first:border-t-0 motion-safe:animate-settle" data-testid="stock-row">
    <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={panelId}
      className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-5 py-3.5 text-left transition-colors hover:bg-white/[0.03] sm:grid-cols-[1.25fr_0.6fr_1fr_1fr_0.95fr_16px]">
      <div className="min-w-0">
        <div className="whitespace-nowrap text-sm font-medium text-cream">{row.symbol}</div>
        <div className="mt-0.5 whitespace-nowrap text-[12px] tabular-nums tracking-[0.02em]">
          <span className="text-smoke">{formatUsd(row.priceUsd)}</span>{" "}
          <span className={toneClass[changeTone(row.change24hPct)]}>{formatChangePct(row.change24hPct)}</span>
        </div>
      </div>
      <div className="hidden text-right sm:block">
        <div className="text-sm tabular-nums text-cream">{formatShares(row.sharesIn ?? row.sharesNow)}</div>
        <div className="mt-0.5 whitespace-nowrap text-[12px] text-smoke">{sub}</div>
      </div>
      <div className="order-3 sm:order-none sm:text-right">
        <div className="whitespace-nowrap text-sm tabular-nums text-cream"><span className="mr-1.5 text-[12px] text-smoke sm:hidden">Price</span>{formatUsd(row.priceChangeUsd, { signed: true })}</div>
        <div className={cn("mt-0.5 whitespace-nowrap text-[12px] tabular-nums", toneClass[changeTone(row.priceChangePct)])}>{row.priceChangePct !== null ? formatChangePct(row.priceChangePct) : "—"}</div>
      </div>
      <div className="order-4 text-right sm:order-none">
        <div className="whitespace-nowrap text-sm tabular-nums text-cream"><span className="mr-1.5 text-[12px] text-smoke sm:hidden">Fees</span>{formatUsd(row.feeUsd)}</div>
        <div className={cn("mt-0.5 whitespace-nowrap text-[12px] tabular-nums", row.feeShares > 0 ? "text-mint" : "text-smoke")}>{row.feeShares > 0 ? "↑ " : ""}{formatShares(row.feeShares)}</div>
      </div>
      <div className="order-2 text-right sm:order-none">
        <div className="whitespace-nowrap text-sm font-medium tabular-nums text-cream">{formatUsd(row.valueUsd)}</div>
      </div>
      <ChevronDown aria-hidden="true" className={cn("hidden h-4 w-4 text-smoke transition-transform duration-200 motion-reduce:transition-none sm:block", open && "rotate-180")} />
    </button>
    <div id={panelId} inert={!open} className={cn("grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
      <div className="overflow-hidden">
        <div className="px-5 pb-5 pt-3"><StockPerformanceTiles stock={row} showHeader={false} showFootnote={false} />
          <StockPools positions={positions} selectedPositionKey={selectedPositionKey} onSelectPosition={onSelectPosition} selectionDisabled={selectionDisabled} />
        </div>
      </div>
    </div>
  </div>;
}

"use client";

import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown, ArrowUpRight } from "lucide-react";
import { HIGHEST_RANGE_APR_7D_HELP, POOL_FEE_APR_24H_HELP, POOL_FEE_APR_24H_SHORT } from "@/lib/apr-labels/copy";
import { exactAprTitle, formatAprPct } from "@/lib/apr-labels/format-apr";
import { cn } from "@/lib/cn";
import type { TokenIconMap } from "@/lib/token-icons/map";
import type { Apr7dState } from "@/lib/unified-pools/apr7d";
import { CHAIN_LABELS, PROTOCOL_LABELS, RISK_LABELS, type PoolChain, type SortDir, type SortKey, type UnifiedPool } from "@/lib/unified-pools/model";
import { InfoTip } from "../info-tip";
import { PairTokenIcons } from "../pair-token-icons";

/* Pool list pieces shared by `/app/rwa-pairs` and the homepage, so both render pools with the same component. */

export const money = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(2)}`;
};
/** Missing APR is "—"; a real but tiny APR is "<0.01%" (never a misleading "0.00%"). */
export const pct = formatAprPct;

export const APR7D_SHORT = "Est. APR · 7d";
export const APR24H_SHORT = POOL_FEE_APR_24H_SHORT;
export const chip = "inline-flex h-6 items-center whitespace-nowrap rounded-full px-2.5 font-data text-[10px] uppercase tracking-[0.12em]";

export function ChainBadge({ chain, tone = "light" }: { chain: PoolChain; tone?: "light" | "dark" }) {
  return <span data-testid="chain-badge" className={cn(chip, chain === "robinhood"
    ? tone === "light" ? "bg-mint text-ink" : "bg-mint/90 text-ink"
    : tone === "light" ? "bg-lilac text-ink" : "bg-lilac/90 text-ink")}>{CHAIN_LABELS[chain]}</span>;
}

export function RiskChips({ pool, tone = "light" }: { pool: UnifiedPool; tone?: "light" | "dark" }) {
  if (!pool.risks.length) return <span className={cn("text-xs", tone === "light" ? "text-ink/55" : "text-smoke")}>No flags</span>;
  return <span className="flex flex-wrap gap-1.5">{pool.risks.map((risk) => (
    <span key={risk} className={cn(chip, risk === "freeze" ? "bg-coral text-ink" : tone === "light" ? "bg-white text-ink" : "border border-white/25 text-cream/80")}>{RISK_LABELS[risk]}</span>
  ))}</span>;
}

export function Apr7dValue({ state, size = "lg" }: { state: Apr7dState | undefined; size?: "lg" | "sm" }) {
  const text = state?.status === "ready" ? pct(state.aprPct) : state?.status === "missing" ? "—" : "…";
  return <span data-testid="apr7d" data-apr-status={state?.status ?? "loading"} title={state?.status === "missing" ? state.reason : undefined}
    className={cn("inline-flex items-center justify-center whitespace-nowrap rounded-full font-semibold tabular-nums",
      size === "lg" ? "h-10 px-4 text-xl" : "h-7 min-w-[3.5rem] px-2.5 text-sm",
      state?.status === "ready" ? "bg-lemon text-ink" : size === "lg" ? "bg-ink/10 text-ink/70" : "bg-white/[0.06] text-cream/70")}>{text}</span>;
}

export type OpenAction = { kind: "open"; onOpen: () => void } | { kind: "link"; href: string } | { kind: "none"; reason: string };

export function OpenButton({ action, label, compact }: { action: OpenAction; label: string; compact?: boolean }) {
  const cls = cn("group inline-flex shrink-0 items-center whitespace-nowrap justify-between gap-3 rounded-full bg-ink pl-4 pr-1.5 text-sm font-semibold text-cream outline-none transition-transform hover:-translate-y-px focus-visible:shadow-[0_0_0_3px_var(--color-lilac)]",
    compact ? "h-9 bg-lemon text-ink" : "h-11");
  const icon = <span className={cn("flex items-center justify-center rounded-full transition-transform group-hover:rotate-45", compact ? "h-6 w-6 bg-ink text-lemon" : "h-8 w-8 bg-lemon text-ink")}>
    <ArrowUpRight className="h-4 w-4" aria-hidden="true" /></span>;
  if (action.kind === "open") return <button type="button" className={cls} onClick={action.onOpen} aria-label={`Open position in ${label}`}>{compact ? "Open" : "Open position"}{icon}</button>;
  if (action.kind === "link") return <Link href={action.href} className={cls} aria-label={`Open position in ${label}`}>{compact ? "Open" : "Open position"}{icon}</Link>;
  return <span className={cn("text-xs", compact ? "text-smoke" : "text-ink/60")}>{action.reason}</span>;
}


/** Wrapped / plain symbols for the token icons, from the "SPCXx/SPCX" pair label (wrapped side first). */
export const iconPair = (pool: UnifiedPool) => {
  const [wrappedSymbol = pool.symbolA, plainSymbol = pool.symbolB] = pool.pairLabel.split("/");
  return { mintA: pool.mintA, mintB: pool.mintB, symbolA: pool.symbolA, wrappedSymbol, plainSymbol };
};

export const COLUMNS: { key: SortKey; label: string; short?: string; help?: string; numeric?: boolean }[] = [
  { key: "name", label: "Pool" },
  { key: "chain", label: "Chain" },
  { key: "protocol", label: "Protocol" },
  { key: "apr7d", label: APR7D_SHORT, short: "Est. APR 7d", help: HIGHEST_RANGE_APR_7D_HELP, numeric: true },
  { key: "apr24h", label: APR24H_SHORT, short: "Est. fee APR 24h", help: POOL_FEE_APR_24H_HELP, numeric: true },
  { key: "tvl", label: "TVL", numeric: true },
  { key: "volume", label: "24h vol", numeric: true },
  { key: "risk", label: "Risk" },
];

/**
 * The pool list (table) view, shared by `/app/rwa-pairs` (List view, sortable) and the homepage (fixed order, no
 * `onSort`): pair with token icons (letter avatar until a logo loads, or when there is none), chain badge, protocol,
 * Est. APR · 7d, 24h fee APR, TVL, 24h volume, risk flags and the open action. The Pool column stays pinned while the
 * table scrolls sideways on narrow screens.
 */
export function PoolTable({ pools, apr, actionFor, sort, onSort, icons, highlightKey, testId = "pools-table", apr24hPending = false }: {
  pools: readonly UnifiedPool[]; apr: Readonly<Record<string, Apr7dState | undefined>>; actionFor: (pool: UnifiedPool) => OpenAction;
  sort: { key: SortKey; dir: SortDir };
  /** Omit for a fixed order: headers are plain labels instead of sort buttons. */
  onSort?: (key: SortKey) => void;
  icons?: TokenIconMap;
  /** Pool key to mark (e.g. a shared link's pool). */
  highlightKey?: string;
  testId?: string;
  /** Show "…" in the 24h APR column (the homepage's prerendered HTML, which never states an APR figure). */
  apr24hPending?: boolean;
}) {
  return <div className="mt-3 overflow-x-auto rounded-[28px] border border-white/12 bg-char">
    <table className="w-full min-w-[980px] text-left text-sm" data-testid={testId}>
      <thead><tr className="border-b border-white/10">
        {COLUMNS.map((column) => {
          const active = sort.key === column.key;
          const Icon = !active ? ArrowUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
          return <th key={column.key} scope="col" aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
            className={cn("px-3 py-3 font-data text-[10px] font-normal uppercase tracking-[0.12em] text-smoke", column.numeric && "text-right",
              column.key === "name" && "sticky left-0 z-10 bg-char")}>
            <span className={cn("inline-flex items-center gap-1 whitespace-nowrap", column.numeric && "justify-end")}>
              {onSort
                ? <button type="button" onClick={() => onSort(column.key)} title={column.label} className={cn("inline-flex items-center gap-1 whitespace-nowrap hover:text-cream", active && "text-cream")}>
                  {column.short ?? column.label}<Icon className="h-3 w-3" aria-hidden="true" />
                </button>
                : <span title={column.label} className={cn(active && "text-cream")}>{column.short ?? column.label}</span>}
              {column.help && <InfoTip label={`About ${column.label}`}>{column.help}</InfoTip>}
            </span>
          </th>;
        })}
        <th scope="col" className="px-3 py-3"><span className="sr-only">Open</span></th>
      </tr></thead>
      <tbody>{pools.map((pool) => (
        <tr key={pool.key} data-pool={pool.key} data-chain={pool.chain} data-highlighted={pool.key === highlightKey ? "true" : undefined}
          className={cn("border-b border-white/[0.06] last:border-0", pool.key === highlightKey && "bg-white/[0.04]")}>
          {/* Narrow on phones (token names from sm up) so the sticky column leaves room for the scrolling APR columns. */}
          <td className="sticky left-0 z-10 bg-char px-3 py-3 shadow-[6px_0_8px_-6px_rgba(0,0,0,0.6)] sm:shadow-none">
            <div className="flex items-center gap-2 sm:gap-3">
              <PairTokenIcons pair={iconPair(pool)} icons={icons} chain={pool.chain} ringClassName="ring-char" iconClassName="h-8 w-8 text-xs" />
              <div className="min-w-0"><p className="whitespace-nowrap font-medium text-cream">{pool.pairLabel}</p><p className="hidden max-w-[12rem] truncate text-xs text-smoke sm:block">{pool.nameA} / {pool.nameB}</p></div>
            </div>
          </td>
          <td className="px-3 py-3"><ChainBadge chain={pool.chain} tone="dark" /></td>
          <td className="px-3 py-3 text-cream/80">{PROTOCOL_LABELS[pool.protocol]}</td>
          <td className="px-3 py-3 text-right"><Apr7dValue state={apr[pool.key]} size="sm" /></td>
          <td className="px-3 py-3 text-right tabular-nums text-cream/80" data-testid="apr24h"
            title={apr24hPending ? undefined : exactAprTitle(pool.poolFeeApr24hPct)}>{apr24hPending ? "…" : pct(pool.poolFeeApr24hPct)}</td>
          <td className="px-3 py-3 text-right tabular-nums text-cream/80">{money(pool.tvlUsd)}</td>
          <td className="px-3 py-3 text-right tabular-nums text-cream/80">{money(pool.volume24hUsd)}</td>
          <td className="px-3 py-3"><RiskChips pool={pool} tone="dark" /></td>
          <td className="px-3 py-3 text-right"><OpenButton action={actionFor(pool)} label={pool.pairLabel} compact /></td>
        </tr>
      ))}</tbody>
    </table>
  </div>;
}

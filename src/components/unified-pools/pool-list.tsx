"use client";

import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown, ArrowUpRight } from "lucide-react";
import { HIGHEST_RANGE_APR_7D_HELP, POOL_FEE_APR_24H_HELP, POOL_FEE_APR_24H_SHORT } from "@/lib/apr-labels/copy";
import { exactAprTitle, formatAprPct } from "@/lib/apr-labels/format-apr";
import { cn } from "@/lib/cn";
import type { TokenIconMap } from "@/lib/token-icons/map";
import type { Apr7dState } from "@/lib/unified-pools/apr7d";
import { CHAIN_LABELS, PROTOCOL_LABELS, type PoolChain, type SortDir, type SortKey, type UnifiedPool } from "@/lib/unified-pools/model";
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

export function ChainBadge({ chain, tone = "light", wrapBelowMd }: { chain: PoolChain; tone?: "light" | "dark"; wrapBelowMd?: boolean }) {
  return <span data-testid="chain-badge" className={cn(chip, wrapBelowMd && "max-md:h-auto max-md:whitespace-normal max-md:px-1.5 max-md:py-1 max-md:text-center max-md:text-[9px] max-md:leading-tight max-md:tracking-[0.08em]", chain === "robinhood"
    ? tone === "light" ? "bg-mint text-ink" : "bg-mint/90 text-ink"
    : tone === "light" ? "bg-lilac text-ink" : "bg-lilac/90 text-ink")}>{CHAIN_LABELS[chain]}</span>;
}

export function Apr7dValue({ state, size = "lg" }: { state: Apr7dState | undefined; size?: "lg" | "sm" }) {
  const text = state?.status === "ready" ? pct(state.aprPct) : state?.status === "missing" ? "—" : "…";
  return <span data-testid="apr7d" data-apr-status={state?.status ?? "loading"} title={state?.status === "missing" ? state.reason : undefined}
    className={cn("inline-flex items-center justify-center whitespace-nowrap rounded-full font-semibold tabular-nums",
      size === "lg" ? "h-10 px-4 text-xl" : "h-7 min-w-[3.5rem] px-2.5 text-sm max-md:min-w-0 max-md:px-2 max-md:text-[13px]",
      state?.status === "ready" ? "bg-lemon text-ink" : size === "lg" ? "bg-ink/10 text-ink/70" : "bg-white/[0.06] text-cream/70")}>{text}</span>;
}

export type OpenAction = { kind: "open"; onOpen: () => void } | { kind: "link"; href: string } | { kind: "none"; reason: string };

export function OpenButton({ action, label, compact, iconOnlyBelowMd }: {
  action: OpenAction; label: string; compact?: boolean;
  /** Below 768px show only the arrow (the text stays for screen readers); unchanged from 768px up. */
  iconOnlyBelowMd?: boolean;
}) {
  const cls = cn("group inline-flex shrink-0 items-center whitespace-nowrap justify-between gap-3 rounded-full bg-ink pl-4 pr-1.5 text-sm font-semibold text-cream outline-none transition-transform hover:-translate-y-px focus-visible:shadow-[0_0_0_3px_var(--color-lilac)]",
    compact ? "h-9 bg-lemon text-ink" : "h-11", iconOnlyBelowMd && "max-md:gap-0 max-md:px-1");
  const text = (value: string) => iconOnlyBelowMd ? <span className="max-md:sr-only">{value}</span> : value;
  const icon = <span className={cn("flex items-center justify-center rounded-full transition-transform group-hover:rotate-45", compact ? "h-6 w-6 bg-ink text-lemon" : "h-8 w-8 bg-lemon text-ink")}>
    <ArrowUpRight className="h-4 w-4" aria-hidden="true" /></span>;
  if (action.kind === "open") return <button type="button" className={cls} onClick={action.onOpen} aria-label={`Open position in ${label}`}>{text(compact ? "Open" : "Open position")}{icon}</button>;
  if (action.kind === "link") return <Link href={action.href} className={cls} aria-label={`Open position in ${label}`}>{text(compact ? "Open" : "Open position")}{icon}</Link>;
  return <span className={cn("text-xs", compact ? "text-smoke" : "text-ink/60")}>{action.reason}</span>;
}


/** Wrapped / plain symbols for the token icons, from the "SPCXx/SPCX" pair label (wrapped side first). */
export const iconPair = (pool: UnifiedPool) => {
  const [wrappedSymbol = pool.symbolA, plainSymbol = pool.symbolB] = pool.pairLabel.split("/");
  return { mintA: pool.mintA, mintB: pool.mintB, symbolA: pool.symbolA, wrappedSymbol, plainSymbol };
};

/** `wide`: only shown from 768px up (below that the table keeps Pool, Chain, Est. APR · 7d and Open, with TVL under the pool name). */
/**
 * "SPCXx/SPCX" as two plain spans that become inline-blocks below 768px, where the pair may then wrap after the "/".
 * (A `<wbr>` would also change the text's kerning from 768px up; plain inline spans render as before.)
 */
const pairWithBreak = (label: string) => {
  const slash = label.indexOf("/");
  return slash < 0 ? label : <><span className="max-md:inline-block">{label.slice(0, slash + 1)}</span><span className="max-md:inline-block">{label.slice(slash + 1)}</span></>;
};

export const COLUMNS: { key: SortKey; label: string; short?: string; help?: string; numeric?: boolean; wide?: boolean }[] = [
  { key: "name", label: "Pool" },
  { key: "chain", label: "Chain" },
  { key: "protocol", label: "Protocol", wide: true },
  { key: "apr7d", label: APR7D_SHORT, short: "Est. APR 7d", help: HIGHEST_RANGE_APR_7D_HELP, numeric: true },
  { key: "apr24h", label: APR24H_SHORT, short: "Est. fee APR 24h", help: POOL_FEE_APR_24H_HELP, numeric: true, wide: true },
  { key: "tvl", label: "TVL", numeric: true, wide: true },
  { key: "volume", label: "24h vol", numeric: true, wide: true },
];
/** Cell classes below 768px: tighter padding; `wide` columns hidden. From 768px up the classes are unchanged. */
const narrow = "max-md:px-1.5";
const wideOnly = "max-md:hidden";

/**
 * The pool list (table) view, shared by `/app/rwa-pairs` (List view, sortable) and the homepage (fixed order, no
 * `onSort`): pair with token icons (letter avatar until a logo loads, or when there is none), chain badge, protocol,
 * Est. APR · 7d, 24h fee APR, TVL, 24h volume and the open action. From 768px up the Pool column stays
 * pinned while the table scrolls sideways if needed; below 768px only Pool (with TVL as a small line), Chain,
 * Est. APR · 7d and an icon-only Open are shown, so the table fits the screen with no horizontal scroll.
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
    <table className="w-full min-w-[980px] text-left text-sm max-md:min-w-0" data-testid={testId}>
      <thead><tr className="border-b border-white/10">
        {COLUMNS.map((column) => {
          const active = sort.key === column.key;
          const Icon = !active ? ArrowUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
          return <th key={column.key} scope="col" aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
            className={cn("px-3 py-3 font-data text-[10px] font-normal uppercase tracking-[0.12em] text-smoke max-md:tracking-[0.06em]", column.numeric && "text-right",
              column.key === "name" && "sticky left-0 z-10 bg-char max-md:static", narrow, column.wide && wideOnly)}>
            {/* Below 768px header labels may wrap so the four narrow columns fit the screen. */}
            <span className={cn("inline-flex items-center gap-1 whitespace-nowrap max-md:whitespace-normal", column.numeric && "justify-end")}>
              {onSort
                ? <button type="button" onClick={() => onSort(column.key)} title={column.label} className={cn("inline-flex items-center gap-1 whitespace-nowrap hover:text-cream max-md:whitespace-normal max-md:text-right", active && "text-cream")}>
                  {column.short ?? column.label}<Icon className="h-3 w-3" aria-hidden="true" />
                </button>
                : <span title={column.label} className={cn(active && "text-cream")}>{column.short ?? column.label}</span>}
              {column.help && <InfoTip label={`About ${column.label}`}>{column.help}</InfoTip>}
            </span>
          </th>;
        })}
        <th scope="col" className={cn("px-3 py-3", narrow)}><span className="sr-only">Open</span></th>
      </tr></thead>
      <tbody>{pools.map((pool) => (
        <tr key={pool.key} data-pool={pool.key} data-chain={pool.chain} data-highlighted={pool.key === highlightKey ? "true" : undefined}
          className={cn("border-b border-white/[0.06] last:border-0", pool.key === highlightKey && "bg-white/[0.04]")}>
          <td className={cn("sticky left-0 z-10 bg-char px-3 py-3 max-md:static", narrow)}>
            <div className="flex items-center gap-3 max-md:gap-2">
              <PairTokenIcons pair={iconPair(pool)} icons={icons} chain={pool.chain} ringClassName="ring-char" iconClassName="h-8 w-8 text-xs max-md:h-6 max-md:w-6 max-md:text-[10px]" />
              <div className="min-w-0">
                {/* Below 768px the pair may break after the "/" so long pairs fit. */}
                <p className="whitespace-nowrap font-medium text-cream max-md:whitespace-normal max-md:leading-tight">{pairWithBreak(pool.pairLabel)}</p>
                <p className="hidden max-w-[8rem] truncate text-xs text-smoke sm:block max-md:hidden" title={`${pool.nameA} / ${pool.nameB}`}>{pool.nameA} / {pool.nameB}</p>
                <p className="mt-0.5 whitespace-nowrap text-xs tabular-nums text-smoke md:hidden" data-testid="tvl-narrow">TVL {money(pool.tvlUsd)}</p>
              </div>
            </div>
          </td>
          <td className={cn("px-3 py-3", narrow)}><ChainBadge chain={pool.chain} tone="dark" wrapBelowMd /></td>
          <td className={cn("px-3 py-3 text-cream/80", wideOnly)}>{PROTOCOL_LABELS[pool.protocol]}</td>
          <td className={cn("px-3 py-3 text-right", narrow)}><Apr7dValue state={apr[pool.key]} size="sm" /></td>
          <td className={cn("px-3 py-3 text-right tabular-nums text-cream/80", wideOnly)} data-testid="apr24h"
            title={apr24hPending ? undefined : exactAprTitle(pool.poolFeeApr24hPct)}>{apr24hPending ? "…" : pct(pool.poolFeeApr24hPct)}</td>
          <td className={cn("px-3 py-3 text-right tabular-nums text-cream/80", wideOnly)}>{money(pool.tvlUsd)}</td>
          <td className={cn("px-3 py-3 text-right tabular-nums text-cream/80", wideOnly)}>{money(pool.volume24hUsd)}</td>
          <td className={cn("px-3 py-3 text-right", narrow)}><OpenButton action={actionFor(pool)} label={pool.pairLabel} compact iconOnlyBelowMd /></td>
        </tr>
      ))}</tbody>
    </table>
  </div>;
}

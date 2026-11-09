"use client";

import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown, ArrowUpRight } from "lucide-react";
import { HIGHEST_RANGE_APR_7D_HELP } from "@/lib/apr-labels/copy";
import { formatAprPct } from "@/lib/apr-labels/format-apr";
import { cn } from "@/lib/cn";
import type { TokenIconMap } from "@/lib/token-icons/map";
import type { Apr7dState } from "@/lib/unified-pools/apr7d";
import { CHAIN_LABELS, isLowTvl, LOW_TVL_LABEL, LOW_TVL_USD, NOT_SUPPORTED_LABEL, PROTOCOL_LABELS, type PoolChain, type SortDir, type SortKey, type UnifiedPool } from "@/lib/unified-pools/model";
import { InfoTip } from "../info-tip";
import { PairTokenIcons } from "../pair-token-icons";
import { dataDaysLabel, MIN_DATA_DAYS } from "@/lib/min-data-days";

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
/**
 * Card headline label once the highest range is known: "Tight-range APR · 7d" for "Tight (±0.05%)", so the number reads
 * as that range's APR, not the whole pool's fee yield. Falls back to `APR7D_SHORT` without a range name.
 */
export function rangeApr7dLabel(rangeLabel: string | null | undefined): string {
  const name = rangeLabel?.replace(/\s*\(.*\)\s*$/, "").trim();
  return name ? `${name}-range APR · 7d` : APR7D_SHORT;
}
export const chip = "inline-flex h-6 items-center whitespace-nowrap rounded-full px-2.5 font-data text-[10px] uppercase tracking-[0.12em]";

export function ChainBadge({ chain, tone = "light", wrapBelowMd }: { chain: PoolChain; tone?: "light" | "dark"; wrapBelowMd?: boolean }) {
  return <span data-testid="chain-badge" className={cn(chip, wrapBelowMd && "max-md:h-auto max-md:whitespace-normal max-md:px-1.5 max-md:py-1 max-md:text-center max-md:text-[9px] max-md:leading-tight max-md:tracking-[0.08em]", chain === "robinhood"
    ? tone === "light" ? "bg-mint text-ink" : "bg-mint/90 text-ink"
    : tone === "light" ? "bg-lilac text-ink" : "bg-lilac/90 text-ink")}>{CHAIN_LABELS[chain]}</span>;
}

/**
 * The 7d APR value. In the table (`sm`) a delayed snapshot that still shows its number (under 48h old) gets a small
 * "Data delayed" line under it; the cards (`lg`) already say it in their "Updated … · Data delayed" line.
 */
/** Shown instead of an APR for a pool with fewer than `MIN_DATA_DAYS` days of data. */
export const NEW_POOL_LABEL = "New pool";

/** "New pool · 6 days of data. An APR shows once it has 7 days." */
export function newPoolTitle(days: number): string {
  return `${NEW_POOL_LABEL} · ${dataDaysLabel(days)}. An APR shows once it has ${MIN_DATA_DAYS} days.`;
}

/** Tooltip of the "Low TVL" tag. */
export const LOW_TVL_TITLE = `Under $${LOW_TVL_USD / 1_000}k in the pool: a few trades can move this APR a lot, so it ranks below bigger pools.`;

/** "Low TVL" tag for a pool under `LOW_TVL_USD` (its APR still shows; it ranks below every bigger pool). */
export function LowTvlTag({ tone }: { tone: "light" | "dark" }) {
  return <span data-testid="low-tvl-tag" title={LOW_TVL_TITLE} className={cn(chip, tone === "light" ? "border border-ink/40 text-ink" : "h-5 border border-white/30 px-2 text-[9px] text-cream/80")}>
    {LOW_TVL_LABEL}<span className="sr-only">: {LOW_TVL_TITLE}</span></span>;
}

export function Apr7dValue({ state, size = "lg", lowTvl = false }: {
  state: Apr7dState | undefined; size?: "lg" | "sm";
  /** Table rows (`sm`) only: add the "Low TVL" tag under the value (cards show it beside the chain badge). */
  lowTvl?: boolean;
}) {
  const text = state?.status === "ready" ? pct(state.aprPct) : state?.status === "new" ? NEW_POOL_LABEL
    : state?.status === "missing" ? "—" : "…";
  const value = <Apr7dPill state={state} size={size} text={text} />;
  if (size !== "sm") return value;
  // Below 768px a note may wrap ("Data / delayed") so the APR column stays narrow enough for a 360 px screen.
  const line = "whitespace-nowrap font-data text-[10px] uppercase tracking-[0.08em] text-cream/60 max-md:whitespace-normal max-md:text-right max-md:text-[9px] max-md:leading-tight";
  // Table rows have no label line under the value, so a new pool's day count, "Data delayed" and "Low TVL" go here.
  const notes = [
    state?.status === "new" && <span key="new" data-testid="apr7d-new-days" className={line}>{dataDaysLabel(state.days)}</span>,
    state?.status === "ready" && state.freshness?.delayed && <span key="delayed" data-testid="apr7d-delayed" className={line}
      title={`Snapshot from ${new Date(state.freshness.snapshotAt).toLocaleString()}`}>Data delayed</span>,
    lowTvl && state?.status !== "new" && <LowTvlTag key="low" tone="dark" />,
  ].filter(Boolean);
  if (!notes.length) return value;
  return <span className="inline-flex flex-col items-end gap-0.5">{value}{notes}</span>;
}

function Apr7dPill({ state, size, text }: { state: Apr7dState | undefined; size: "lg" | "sm"; text: string }) {
  return <span data-testid="apr7d" data-apr-status={state?.status ?? "loading"} title={state?.status === "missing" ? state.reason : state?.status === "new" ? newPoolTitle(state.days) : undefined}
    className={cn("inline-flex items-center justify-center whitespace-nowrap rounded-full font-semibold tabular-nums",
      size === "lg" ? "h-10 px-4 text-xl" : "h-7 min-w-[3.5rem] px-2.5 text-sm max-md:min-w-0 max-md:px-2 max-md:text-[13px]",
      state?.status === "ready" ? "bg-lemon text-ink" : size === "lg" ? "bg-ink/10 text-ink/70" : "bg-white/[0.06] text-cream/70")}>{text}</span>;
}

export type OpenAction = { kind: "open"; onOpen: () => void } | { kind: "link"; href: string } | { kind: "none"; reason: string }
  /** A greyed, disabled Open button with the reason shown next to it (e.g. Meteora pools). */
  | { kind: "disabled"; reason: string }
  /** The pool's tokens use a setting opening does not handle yet: a greyed "Not supported yet" with the reason as its tooltip. */
  | { kind: "unsupported"; reason: string };

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
  // Below 768px an icon-only Open that cannot be used is a greyed arrow plus an ⓘ with the reason (as the homepage stock
  // cards do), so the four narrow columns still fit a 360 px screen; from 768px up the reason / pill shows as before.
  const narrowInfo = (tip: string) => iconOnlyBelowMd && <span className="md:hidden">
    <InfoTip label={tip} tone="dark" placement="below">{action.kind === "disabled" || action.kind === "unsupported" ? action.reason : ""}</InfoTip></span>;
  if (action.kind === "disabled") return <span className={cn("inline-flex gap-1.5", compact ? "flex-col items-end" : "flex-wrap items-center gap-x-3",
    iconOnlyBelowMd && "max-md:items-center max-md:gap-0.5")} data-testid="open-disabled">
    <button type="button" disabled aria-disabled="true" title={action.reason} aria-label={`Open position in ${label}: ${action.reason}`}
      className={cn(cls, "cursor-not-allowed opacity-45 hover:translate-y-0")}>{text(compact ? "Open" : "Open position")}{icon}</button>
    <span className={cn("text-xs", compact ? "max-w-[11rem] text-right text-[11px] leading-tight text-smoke max-md:max-w-[6.5rem] max-md:text-[10px]" : "text-ink/65",
      iconOnlyBelowMd && "max-md:hidden")}>{action.reason}</span>
    {narrowInfo(`Why ${label} cannot be opened here`)}
  </span>;
  if (action.kind === "unsupported") return <span data-testid="open-unsupported" aria-disabled="true" title={action.reason} className="inline-flex shrink-0 items-center">
    {iconOnlyBelowMd && <span className="inline-flex flex-col items-center gap-0.5 md:hidden" data-testid="open-unsupported-narrow">
      {/* Not an Open action: it says so, like the pill it stands in for. */}
      <button type="button" disabled aria-label={`${label}: ${NOT_SUPPORTED_LABEL}. ${action.reason}`}
        className={cn(cls, "cursor-not-allowed opacity-45 hover:translate-y-0")}>{text("Open")}{icon}</button>
      {narrowInfo(`Why ${label} is not supported yet`)}
    </span>}
    <span className={cn("inline-flex shrink-0 cursor-not-allowed items-center gap-1.5 rounded-full border text-sm font-semibold",
      compact ? "min-h-9 whitespace-nowrap border-white/20 px-3 text-cream/60 max-md:px-2 max-md:text-[11px] max-md:leading-tight" : "h-11 border-ink/20 px-4 text-ink/45",
      iconOnlyBelowMd && "max-md:hidden")}>
      <span>{NOT_SUPPORTED_LABEL}</span>
      <InfoTip label={`Why ${label} is not supported yet`} tone={compact ? "dark" : "light"} placement={compact ? "below" : "above"}>{action.reason}</InfoTip>
    </span>
  </span>;
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
  { key: "tvl", label: "TVL", numeric: true, wide: true },
  { key: "volume", label: "24h vol", numeric: true, wide: true },
];
/** Cell classes below 768px: tighter padding; `wide` columns hidden. From 768px up the classes are unchanged. */
const narrow = "max-md:px-1.5";
const wideOnly = "max-md:hidden";

/**
 * The pool list (table) view, shared by `/app/rwa-pairs` (List view, sortable) and the homepage (fixed order, no
 * `onSort`): pair with token icons (letter avatar until a logo loads, or when there is none), chain badge, protocol,
 * Est. APR · 7d (the only APR shown), TVL, 24h volume and the open action. From 768px up the Pool column stays
 * pinned while the table scrolls sideways if needed; below 768px only Pool (with TVL as a small line), Chain,
 * Est. APR · 7d and an icon-only Open are shown, so the table fits the screen with no horizontal scroll.
 */
export function PoolTable({ pools, apr, actionFor, sort, onSort, icons, highlightKey, testId = "pools-table" }: {
  pools: readonly UnifiedPool[]; apr: Readonly<Record<string, Apr7dState | undefined>>; actionFor: (pool: UnifiedPool) => OpenAction;
  sort: { key: SortKey; dir: SortDir };
  /** Omit for a fixed order: headers are plain labels instead of sort buttons. */
  onSort?: (key: SortKey) => void;
  icons?: TokenIconMap;
  /** Pool key to mark (e.g. a shared link's pool). */
  highlightKey?: string;
  testId?: string;
}) {
  // `relative` keeps the absolutely positioned sr-only labels inside this scroller (else they widen the page on phones).
  return <div className="relative mt-3 overflow-x-auto rounded-[28px] border border-white/12 bg-char">
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
                {/* Below 768px the Protocol column is hidden: the badge tells the same pair on two protocols apart. */}
                <span className="mt-1 inline-flex h-5 items-center whitespace-nowrap rounded-full border border-white/25 px-1.5 font-data text-[9px] uppercase tracking-[0.04em] text-cream/80 md:hidden" data-testid="protocol-badge-narrow">{PROTOCOL_LABELS[pool.protocol]}</span>
              </div>
            </div>
          </td>
          <td className={cn("px-3 py-3", narrow)}><ChainBadge chain={pool.chain} tone="dark" wrapBelowMd /></td>
          <td className={cn("px-3 py-3 text-cream/80", wideOnly)}><span className={cn(chip, "border border-white/25")} data-testid="protocol-badge">{PROTOCOL_LABELS[pool.protocol]}</span></td>
          <td className={cn("px-3 py-3 text-right", narrow)}><Apr7dValue state={apr[pool.key]} size="sm" lowTvl={isLowTvl(pool)} /></td>
          <td className={cn("px-3 py-3 text-right tabular-nums text-cream/80", wideOnly)}>{money(pool.tvlUsd)}</td>
          <td className={cn("px-3 py-3 text-right tabular-nums text-cream/80", wideOnly)}>{money(pool.volume24hUsd)}</td>
          <td className={cn("px-3 py-3 text-right", narrow)}><OpenButton action={actionFor(pool)} label={pool.pairLabel} compact iconOnlyBelowMd /></td>
        </tr>
      ))}</tbody>
    </table>
  </div>;
}

"use client";

import { cn } from "@/lib/cn";
import { formatUsd } from "@/lib/format/usd";
import type { PositionFigures } from "@/lib/portfolio/figures";
import { formatShares } from "@/lib/stock-performance-format";
import type { PositionGroup } from "@/lib/unified-positions/rows";
import { CLOSED_LABEL, isClosed } from "@/lib/unified-positions/rows";
import type { SourceCapabilities, ToolId, UnifiedPosition } from "@/lib/unified-positions/model";
import { RangeBadge } from "../unified-positions/range-badge";

export type RowAction = { tool: ToolId; label: string };

/**
 * The actions a row offers: only what that position's DEX supports (its capabilities, from the descriptor registry or
 * the inline source), never a greyed button. Compound first; Withdraw reads "Close" where only a full close exists.
 */
export function rowActions(capabilities: SourceCapabilities, closed: boolean): RowAction[] {
  if (closed) return capabilities.withdraw.supported ? [{ tool: "withdraw", label: "Close" }] : [];
  return [
    ...(capabilities.compound.supported ? [{ tool: "compound" as const, label: "Compound" }] : []),
    ...(capabilities.deposit.supported ? [{ tool: "deposit" as const, label: "Add" }] : []),
    ...(capabilities.withdraw.supported ? [{ tool: "withdraw" as const, label: capabilities.withdraw.partial ? "Withdraw" : "Close" }] : []),
  ];
}

export type PortfolioRow = {
  item: UnifiedPosition;
  /** Ticker for same-stock pools ("TSLA"), else the pair. */
  title: string;
  /** Pair (when the title is the ticker), the DEX name when the chain lists 2+ DEXes, and the position number. */
  subtitle: string;
  /** Null while its numbers are read (or for a chain without them): dashes. */
  figures: PositionFigures | null;
  actions: RowAction[];
};

const COLS = "lg:grid-cols-[minmax(0,1.4fr)_minmax(0,0.7fr)_minmax(0,0.8fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,1.5fr)]";
const usd = (value: number | null | undefined) => formatUsd(value ?? null);

function Badge({ item }: { item: UnifiedPosition }) {
  return isClosed(item) ? <span data-testid="range-badge" className="rounded-full border border-white/15 px-2 py-0.5 text-[11px] text-smoke">{CLOSED_LABEL}</span>
    : <RangeBadge status={item.rangeStatus} compact />;
}

/**
 * Portfolio "All positions": one row per position (desktop: stock, shares, value, unclaimed and cumulative fees,
 * actions; phone: a card with the compound button at the bottom). Clicking a row opens its details; an action opens the
 * details on that tool. Nothing here sends a transaction.
 */
export function PortfolioPositionList({ groups, rows, selectedKey, disabled, onSelect, onAction }: {
  groups: PositionGroup[];
  rows: ReadonlyMap<string, PortfolioRow>;
  selectedKey: string;
  disabled: boolean;
  onSelect: (key: string) => void;
  onAction: (key: string, tool: ToolId) => void;
}) {
  return <div className="space-y-4" data-testid="position-fallback-rows">
    <div aria-hidden="true" className={cn("hidden gap-3 px-4 text-[11px] font-semibold text-smoke lg:grid", COLS)}>
      <span>Stock</span><span>Shares</span><span>Value</span><span>Unclaimed fees</span><span>Cumulative fees</span><span>Actions</span>
    </div>
    {groups.map((group) => {
      const items = group.positions.flatMap((item) => rows.get(item.key) ?? []);
      if (!items.length) return null;
      return <section key={group.chain} aria-label={group.label} data-testid="position-chain-group">
        <h3 className="mb-2 text-xs font-semibold text-smoke">{group.label}</h3>
        <ul className="space-y-2">{items.map((row) => <PositionRow key={row.item.key} row={row} selected={selectedKey === row.item.key}
          disabled={disabled} onSelect={onSelect} onAction={onAction} />)}</ul>
      </section>;
    })}
  </div>;
}

function PositionRow({ row, selected, disabled, onSelect, onAction }: {
  row: PortfolioRow; selected: boolean; disabled: boolean; onSelect: (key: string) => void; onAction: (key: string, tool: ToolId) => void;
}) {
  const { item, figures } = row;
  const [primary, ...rest] = row.actions;
  const action = (target: RowAction, className: string) => <button key={target.tool} type="button" disabled={disabled}
    data-testid="position-row-action" data-tool={target.tool} onClick={() => onAction(item.key, target.tool)}
    className={cn("rounded-full px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40", className)}>{target.label}</button>;
  const primaryClass = (tool: ToolId) => tool === "compound" ? "bg-lemon text-ink enabled:hover:bg-[#fff27f]" : "border border-white/25 text-cream enabled:hover:border-white/50";
  return <li data-testid="position-row" data-row-key={item.key}
    className={cn("rounded-2xl border transition-colors lg:grid lg:items-center lg:gap-3 lg:rounded-xl", COLS, selected ? "border-mint/40 bg-mint/5" : "border-white/10")}>
    <button type="button" data-testid="position-fallback-select" data-position-key={item.key} aria-pressed={selected} disabled={disabled}
      onClick={() => onSelect(item.key)}
      className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 rounded-2xl px-4 py-3 text-left text-sm enabled:hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50 lg:col-span-5 lg:grid-cols-subgrid lg:rounded-xl">
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2 font-semibold text-cream"><span data-testid="position-row-title">{row.title}</span><Badge item={item} />
          {selected && <span className="text-xs font-normal text-mint">Selected</span>}</span>
        <span className="mt-0.5 block break-words text-xs text-smoke lg:truncate" data-testid="position-row-subtitle">{row.subtitle}</span>
      </span>
      {/* Phone card: value on the right, shares and unclaimed fees under it. */}
      <span className="text-right lg:hidden">
        <span className="block font-semibold tabular-nums text-cream">{usd(figures?.valueUsd)}</span>
        <span className="block whitespace-nowrap text-xs tabular-nums text-smoke">{formatShares(figures?.shares)} shares</span>
        <span className="block whitespace-nowrap text-xs tabular-nums text-smoke">Unclaimed {usd(figures?.unclaimedFeesUsd)}</span>
      </span>
      <span className="hidden tabular-nums text-cream/90 lg:block" data-testid="position-row-shares">{formatShares(figures?.shares)}</span>
      <span className="hidden tabular-nums text-cream/90 lg:block" data-testid="position-row-value">{usd(figures?.valueUsd)}</span>
      <span className="hidden tabular-nums text-cream/90 lg:block" data-testid="position-row-unclaimed">{usd(figures?.unclaimedFeesUsd)}</span>
      <span className="hidden tabular-nums text-cream/90 lg:block" data-testid="position-row-cumulative">{usd(figures?.cumulativeFeesUsd)}</span>
    </button>
    {primary && <div className="flex flex-wrap gap-2 border-t border-white/10 px-4 py-3 lg:border-0 lg:px-0 lg:py-0 lg:pr-4">
      {/* Phone: the first action (Compound where the DEX has it) fills the bottom of the card. */}
      {action(primary, cn(primaryClass(primary.tool), "max-lg:flex-1 max-lg:py-2.5"))}
      {rest.map((target) => action(target, "border border-white/25 text-cream enabled:hover:border-white/50"))}
    </div>}
  </li>;
}

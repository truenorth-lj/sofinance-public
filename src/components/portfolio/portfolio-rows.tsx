"use client";

import type { ReactNode } from "react";
import { LoaderCircle, Sprout } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatUsd } from "@/lib/format/usd";
import type { PositionFigures } from "@/lib/portfolio/figures";
import { formatShares } from "@/lib/stock-performance-format";
import type { PositionGroup } from "@/lib/unified-positions/rows";
import { CLOSED_LABEL, isClosed } from "@/lib/unified-positions/rows";
import type { SourceCapabilities, ToolId, UnifiedPosition } from "@/lib/unified-positions/model";
import { RangeBadge } from "../unified-positions/range-badge";

/** A row's buttons: Compound, Add, Withdraw (or Close) and Activity, each opening its popup (LJ 11/14). */
export type RowTool = Exclude<ToolId, "performance"> | "activity";
export type RowAction = { tool: RowTool; label: string };

/**
 * The actions a row offers: only what that position's DEX supports (its capabilities, from the descriptor registry or
 * the inline source), never a greyed button. Compound first; Withdraw reads "Close" where only a full close exists.
 * `activity`: the position's source records this session's transactions (the Solana DEXes), so the row has Activity.
 */
export function rowActions(capabilities: SourceCapabilities, closed: boolean, { activity = false }: { activity?: boolean } = {}): RowAction[] {
  const more = activity ? [{ tool: "activity" as const, label: "Activity" }] : [];
  if (closed) return [...(capabilities.withdraw.supported ? [{ tool: "withdraw" as const, label: "Close" }] : []), ...more];
  return [
    ...(capabilities.compound.supported ? [{ tool: "compound" as const, label: "Compound" }] : []),
    ...(capabilities.deposit.supported ? [{ tool: "deposit" as const, label: "Add" }] : []),
    ...(capabilities.withdraw.supported ? [{ tool: "withdraw" as const, label: capabilities.withdraw.partial ? "Withdraw" : "Close" }] : []),
    ...more,
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
  /**
   * The row's own Compound (LJ 11/14: the only Compound entry). Renders the actions bar itself (its Compound button first,
   * then `otherActions`) and its Compound popup (the popup lives with the row's flow, so its progress survives a close).
   */
  compound?: (slot: RowCompoundSlot) => ReactNode;
  /** A page-run operation in progress on this row (Add or Withdraw): that button keeps its popup reachable and says so. */
  busy?: { tool: RowTool; label: string };
};

export type RowCompoundSlot = {
  otherActions: ReactNode;
  disabled: boolean;
  /** This row's Compound popup is open. */
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** The row's unclaimed fees (USD), the popup's static confirm line; null while unread. */
  unclaimedUsd: number | null;
};

/** The popup a row opened: which row and which button. */
export type RowPopup = { key: string; tool: RowTool; open: boolean };

/**
 * The row actions bar (phone: under the card, Compound on its own line above the others). One line on desktop: the
 * Compound button has a fixed width there and truncates a long status label instead.
 */
export function RowActionsBar({ children }: { children: ReactNode }) {
  // Phone: Compound fills the first line, the other buttons share the second. Desktop: one line.
  return <div data-testid="row-actions" className="flex flex-wrap items-center gap-2 lg:flex-nowrap [&>button:not(:first-child)]:max-lg:flex-1 [&>button:not(:first-child)]:max-lg:justify-center [&>button:not(:first-child)]:max-lg:py-2.5 border-t border-white/10 px-4 py-3 lg:border-0 lg:px-0 lg:py-0 lg:pr-4 [&>button:not(:first-child)]:shrink-0 [&>button]:whitespace-nowrap">{children}</div>;
}

/** The row's Compound button look (lemon; a fixed width on desktop, the card's leftover width on a phone). */
export const ROW_COMPOUND_CLASS = "inline-flex min-w-0 items-center justify-center gap-1.5 rounded-full border border-transparent bg-lemon px-3 py-1.5 text-xs font-semibold text-ink transition-colors enabled:hover:bg-[#fff27f] disabled:cursor-not-allowed disabled:opacity-40 max-lg:basis-full max-lg:py-2.5 lg:w-[11rem] lg:shrink-0";

/** The Compound button's icon and label: a long status ("Confirming in wallet…") truncates, never wraps the row. */
export function RowCompoundLabel({ busy, label }: { busy: boolean; label: string }) {
  return <>
    {busy ? <LoaderCircle aria-hidden="true" className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" /> : <Sprout aria-hidden="true" className="size-3.5 shrink-0" />}
    <span className="min-w-0 truncate">{label}</span>
  </>;
}

// Actions: Compound (fixed width) + Add + Withdraw + Activity on one line.
const COLS = "lg:grid-cols-[minmax(0,1.4fr)_minmax(0,0.7fr)_minmax(0,0.8fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(27.5rem,1.6fr)]";
const usd = (value: number | null | undefined) => formatUsd(value ?? null);

function Badge({ item }: { item: UnifiedPosition }) {
  return isClosed(item) ? <span data-testid="range-badge" className="rounded-full border border-white/15 px-2 py-0.5 text-[11px] text-smoke">{CLOSED_LABEL}</span>
    : <RangeBadge status={item.rangeStatus} compact />;
}

/** Clicks that belong to a control inside the row (its buttons, links, popups), not to the row itself. */
const OWN_CONTROLS = "button:not([data-row-open]), a, input, select, textarea, dialog";

/**
 * Portfolio "All positions": one row per position (desktop: stock, shares, value, unclaimed and cumulative fees,
 * actions; phone: a card with the actions at the bottom). Clicking the row (anywhere but its buttons) opens the position's
 * Performance detail; each button opens its popup (Compound / Add / Withdraw / Activity). Nothing expands under a row.
 */
export function PortfolioPositionList({ groups, rows, disabled, popup, onOpenDetail, onAction, onClosePopup }: {
  groups: PositionGroup[];
  rows: ReadonlyMap<string, PortfolioRow>;
  /** An operation runs: every button but the running one's is greyed. */
  disabled: boolean;
  popup: RowPopup | null;
  onOpenDetail: (key: string) => void;
  onAction: (key: string, tool: RowTool) => void;
  onClosePopup: () => void;
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
        <ul className="space-y-2">{items.map((row) => <PositionRow key={row.item.key} row={row} disabled={disabled}
          popup={popup?.key === row.item.key ? popup : null} onOpenDetail={onOpenDetail} onAction={onAction} onClosePopup={onClosePopup} />)}</ul>
      </section>;
    })}
  </div>;
}

function PositionRow({ row, disabled, popup, onOpenDetail, onAction, onClosePopup }: {
  row: PortfolioRow; disabled: boolean; popup: RowPopup | null; onOpenDetail: (key: string) => void;
  onAction: (key: string, tool: RowTool) => void; onClosePopup: () => void;
}) {
  const { item, figures } = row;
  const [primary, ...rest] = row.actions;
  const action = (target: RowAction, className: string) => {
    const busy = row.busy?.tool === target.tool ? row.busy : null;
    return <button key={target.tool} type="button" disabled={disabled && !busy} aria-haspopup="dialog" aria-busy={busy ? true : undefined}
      data-testid="position-row-action" data-tool={target.tool} onClick={() => onAction(item.key, target.tool)} title={busy?.label}
      className={cn("inline-flex items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40", className)}>
      {busy ? <><LoaderCircle aria-hidden="true" className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />{busy.label}</> : target.label}</button>;
  };
  const primaryClass = (tool: RowTool) => tool === "compound" ? "bg-lemon text-ink enabled:hover:bg-[#fff27f]" : "border border-white/25 text-cream enabled:hover:border-white/50";
  return <li data-testid="position-row" data-row-key={item.key}
    // The row button below is the keyboard and screen-reader way in; this only widens the click target to the whole row.
    onClick={(event) => { if (!(event.target instanceof Element) || !event.target.closest(OWN_CONTROLS)) onOpenDetail(item.key); }}
    className={cn("cursor-pointer rounded-2xl border border-white/10 transition-colors hover:border-white/25 lg:grid lg:items-center lg:gap-3 lg:rounded-xl", COLS)}>
    <button type="button" data-row-open="" data-testid="position-fallback-select" data-position-key={item.key} aria-haspopup="dialog"
      aria-label={`${row.title}${row.subtitle ? ` (${row.subtitle})` : ""}: open performance details`}
      className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 rounded-2xl px-4 py-3 text-left text-sm hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lemon lg:col-span-5 lg:grid-cols-subgrid lg:rounded-xl">
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2 font-semibold text-cream"><span data-testid="position-row-title">{row.title}</span><Badge item={item} /></span>
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
    {primary?.tool === "compound" && row.compound
      ? row.compound({ disabled, otherActions: rest.map((target) => action(target, "border border-white/25 text-cream enabled:hover:border-white/50")),
        open: popup?.tool === "compound" && popup.open, onOpen: () => onAction(item.key, "compound"), onClose: onClosePopup,
        unclaimedUsd: figures?.unclaimedFeesUsd ?? null })
      : primary && <RowActionsBar>
        {/* Phone: the first action (Compound where the DEX has it) fills the bottom of the card. */}
        {action(primary, cn(primaryClass(primary.tool), "max-lg:min-w-0 max-lg:flex-1 max-lg:py-2.5"))}
        {rest.map((target) => action(target, "border border-white/25 text-cream enabled:hover:border-white/50"))}
      </RowActionsBar>}
  </li>;
}

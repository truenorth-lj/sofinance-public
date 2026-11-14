import { cn } from "@/lib/cn";
import type { RangeStatus } from "@/lib/unified-positions/model";

/** Row label only: `formatRangeStatus` (position-label.ts) is unchanged. An unread range says so instead of disappearing. */
const TEXT: Readonly<Record<RangeStatus, string>> = { in: "In range", below: "Out of range", above: "Out of range", unknown: "Range unknown" };

/** The only range status on /app: a quiet grey "In range" / "Out of range" badge. No edge or rebalance hints. */
export function RangeBadge({ status, compact = false }: { status: RangeStatus; compact?: boolean }) {
  return <span data-testid="range-badge" data-range-status={status}
    className={cn("whitespace-nowrap rounded-full border border-white/15 text-smoke", compact ? "px-2 py-0.5 text-[11px] font-normal" : "px-2.5 py-1 text-xs")}>{TEXT[status]}</span>;
}

import type { RangeStatus } from "@/lib/unified-positions/model";

const TEXT: Readonly<Record<RangeStatus, string | null>> = { in: "In range", below: "Out of range", above: "Out of range", unknown: null };

/** The only range status on /app: a quiet grey "In range" / "Out of range" badge. No edge or rebalance hints. */
export function RangeBadge({ status }: { status: RangeStatus }) {
  const text = TEXT[status];
  return text ? <span data-testid="range-badge" className="rounded-full border border-white/15 px-2.5 py-1 text-xs text-smoke">{text}</span> : null;
}

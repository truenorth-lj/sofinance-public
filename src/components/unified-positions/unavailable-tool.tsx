import { CircleAlert } from "lucide-react";

/** Inline panel for a greyed tool tab: the capability's reason, no tooltip (PM decision Q4). */
export function UnavailableTool({ id, reason }: { id: string; reason: string }) {
  return <div id={id} role="status" data-testid="tool-unavailable"
    className="mt-3 flex gap-2 rounded-[28px] border border-white/12 bg-char p-5 text-sm text-cream/80 sm:p-8">
    <CircleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-smoke" />{reason}
  </div>;
}

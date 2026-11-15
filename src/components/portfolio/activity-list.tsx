"use client";

import type { ReactNode } from "react";
import { CheckCircle2, CircleAlert, LoaderCircle } from "lucide-react";
import { shortAddress } from "@/lib/format/address";
import { solscanTxUrl } from "@/lib/format/explorer";
import { useSessionActivity, type ActivityEntry } from "@/lib/portfolio/session-activity";

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function Icon({ status }: { status: ActivityEntry["status"] }) {
  if (status === "success") return <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-mint" />;
  if (status === "failed") return <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-lemon" />;
  return <LoaderCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 animate-spin text-lilac motion-reduce:animate-none" />;
}

/**
 * The Activity popup's body: this session's results for one position, newest first (nothing is stored). `records` is the
 * source's own saved records (Raydium: the last compound transaction and any cleanup), `footer` its links.
 */
export function ActivityList({ positionKey, records, footer, savedSignatures = [] }: { positionKey: string; records?: ReactNode; footer?: ReactNode; savedSignatures?: readonly string[] }) {
  // A richer saved record wins over the session summary for the same transaction.
  const entries = useSessionActivity(positionKey).filter((entry) => !entry.signature || !savedSignatures.includes(entry.signature));
  return <div data-testid="activity-list" className="mt-4 text-sm">
    {entries.length ? <ul className="space-y-2">{entries.map((entry) => <li key={entry.id} data-testid="activity-entry" data-status={entry.status}
      className="flex gap-2 rounded-2xl border border-white/10 p-3">
      <Icon status={entry.status} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline justify-between gap-x-3"><span className="font-semibold text-cream">{entry.title}</span>
          <span className="text-xs tabular-nums text-smoke">{time(entry.at)}</span></p>
        {entry.detail ? <p className="mt-1 break-words text-xs leading-5 text-cream/80">{entry.detail}</p> : null}
        {entry.signature ? <a href={solscanTxUrl(entry.signature)} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-cream/80 underline">
          View transaction {shortAddress(entry.signature)}</a> : null}
      </div>
    </li>)}</ul> : !savedSignatures.length ? <p data-testid="activity-empty" className="text-smoke">No activity on this position in this session yet.</p> : null}
    {records}
    {footer}
  </div>;
}

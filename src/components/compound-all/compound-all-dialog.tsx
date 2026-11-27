"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Check, CircleAlert, LoaderCircle, Pause } from "lucide-react";
import { cn } from "@/lib/cn";
import { COMPOUND_ALL_RECOVERY_PATH, compoundAllApprovals, summarizeCompoundAll, type CompoundAllRow, type CompoundAllState } from "@/lib/compound-all/state";
import { ActionDialog } from "../portfolio/action-dialog";
import { approvalsLine, cleanupStatusLabel, COMPOUND_ALL_COPY as COPY, rowResultUnconfirmed, rowStatusLabel, summaryHeading, summaryItems } from "./compound-all-copy";

type CompoundAllRowLabel = { title: string; subtitle?: string };
export type CompoundAllActions = {
  select: (key: CompoundAllRow["key"], selected: boolean) => void;
  start: () => void; retry: () => void; skip: () => void; continue: () => void; cancel: () => void;
  runCleanup: () => void; skipCleanup: () => void;
};

const IN_FLIGHT = new Set(["preparing", "awaiting-wallet", "confirming"]);
const FAILED = new Set(["rejected", "expired", "failed"]);
const primary = "inline-flex items-center justify-center gap-2 rounded-full bg-lemon px-5 py-3 text-sm font-semibold text-ink transition-colors enabled:hover:bg-[#fff27f] disabled:cursor-not-allowed disabled:opacity-40";
const secondary = "inline-flex items-center justify-center gap-2 rounded-full border border-white/25 px-5 py-3 text-sm font-semibold text-cream transition-colors enabled:hover:border-white/50 disabled:cursor-not-allowed disabled:opacity-40";

/** Whether the popup may be closed: before Start, and once the run ended. In between, Stop ends it first. */
export const compoundAllDismissible = (state: CompoundAllState | null) => !state || ["setup", "finished", "cancelled"].includes(state.phase);

/**
 * Compound all's popup (LJ 11/26): the checklist before Start with the approval count, then each row's progress, the
 * pauses (every 10 rows, and on any failure with Retry / Skip), the one final Raydium cleanup row, and the summary.
 * It only renders the runner's state and forwards the user's answers; the runner signs nothing ahead of its turn.
 */
export function CompoundAllDialog({ open, state, labelOf, dexName, actions, onClose }: {
  open: boolean; state: CompoundAllState | null; labelOf: (key: CompoundAllRow["key"]) => CompoundAllRowLabel;
  dexName: (dex: CompoundAllRow["dex"]) => string; actions: CompoundAllActions; onClose: () => void;
}) {
  const dismissible = compoundAllDismissible(state);
  return <ActionDialog open={open} onClose={onClose} title={COPY.title} testId="compound-all-popup" size="md" dismissible={dismissible}>
    {state ? <CompoundAllBody state={state} labelOf={labelOf} dexName={dexName} actions={actions} onClose={onClose} /> : null}
  </ActionDialog>;
}

function CompoundAllBody({ state, labelOf, dexName, actions, onClose }: {
  state: CompoundAllState; labelOf: (key: CompoundAllRow["key"]) => CompoundAllRowLabel; dexName: (dex: CompoundAllRow["dex"]) => string;
  actions: CompoundAllActions; onClose: () => void;
}) {
  const setup = state.phase === "setup";
  const ended = state.phase === "finished" || state.phase === "cancelled";
  const rows = setup || ended ? state.rows : state.rows.filter((row) => row.selected);
  const approvals = compoundAllApprovals(state);
  const showCleanup = setup ? approvals.cleanup > 0 : state.cleanup.status !== "none";
  return <div data-testid="compound-all-body" data-phase={state.phase}>
    {setup ? <>
      <p className="mt-2 text-sm leading-6 text-cream/80">{COPY.intro}</p>
      <ApprovalPreview approvals={approvals} />
    </> : ended ? <Summary state={state} /> : <Progress state={state} />}
    <ol className="mt-4 divide-y divide-white/10 rounded-2xl border border-white/10" data-testid="compound-all-rows">
      {rows.map((row) => <Row key={row.key} row={row} label={labelOf(row.key)} dexName={dexName(row.dex)} setup={setup}
        active={state.active === row.key} onSelect={(selected) => actions.select(row.key, selected)} />)}
      {showCleanup ? <CleanupRow state={state} /> : null}
    </ol>
    {setup ? <p className="mt-3 text-xs text-smoke">{COPY.unlisted}</p> : null}
    <Controls state={state} actions={actions} onClose={onClose} approvalsTotal={approvals.total} />
  </div>;
}

function ApprovalPreview({ approvals }: { approvals: { rows: number; cleanup: number; total: number } }) {
  const line = approvalsLine(approvals);
  return <div data-testid="compound-all-approvals" className="mt-4 rounded-2xl border border-white/15 bg-white/[0.04] p-4">
    <p className="text-sm font-semibold text-cream">Start asks for <span className="tabular-nums">{line.headline}</span></p>
    <p className="mt-1 text-xs text-smoke">{line.detail}. Each one opens only when it is that position&rsquo;s turn.</p>
  </div>;
}

function Progress({ state }: { state: CompoundAllState }) {
  const selected = state.rows.filter((row) => row.selected);
  const finished = selected.filter((row) => row.status === "done" || row.status === "skipped").length;
  return <p role="status" data-testid="compound-all-progress" className="mt-2 text-sm text-cream/80">
    <span className="tabular-nums">{finished} of {selected.length}</span> positions finished
    {state.cancelRequested ? " · stopping after this one" : ""}
  </p>;
}

function StatusIcon({ status }: { status: string }) {
  if (IN_FLIGHT.has(status)) return <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin text-lemon motion-reduce:animate-none" />;
  if (status === "done") return <Check aria-hidden="true" className="size-4 shrink-0 text-lemon" />;
  if (FAILED.has(status)) return <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-cream" />;
  return <span aria-hidden="true" className="block size-4 shrink-0 rounded-full border border-white/25" />;
}

function Row({ row, label, dexName, setup, active, onSelect }: {
  row: CompoundAllRow; label: CompoundAllRowLabel; dexName: string; setup: boolean; active: boolean; onSelect: (selected: boolean) => void;
}) {
  const status = rowStatusLabel(row);
  const failed = FAILED.has(row.status);
  return <li data-testid="compound-all-row" data-key={row.key} data-status={row.status} data-selected={row.selected}
    className={cn("flex items-start gap-3 px-4 py-3", active && "bg-white/[0.05]")}>
    {setup
      ? <input type="checkbox" checked={row.selected} onChange={(event) => onSelect(event.target.checked)} aria-label={`Include ${label.title}`}
        data-testid="compound-all-row-check" className="mt-0.5 size-4 shrink-0 accent-[#fff27f]" />
      : <span className="mt-0.5 flex shrink-0"><StatusIcon status={row.selected ? row.status : "queued"} /></span>}
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm font-semibold text-cream">{label.title}</p>
      <p className="truncate text-xs text-smoke">{[label.subtitle, dexName].filter(Boolean).join(" · ")}</p>
      {row.partToWallet ? <p data-testid="compound-all-out-of-range" className="mt-1 text-xs text-cream/80">
        <span className="mr-1.5 rounded-full border border-white/25 px-1.5 py-px text-[11px] font-semibold">Out of range</span>{setup ? COPY.outOfRange : null}</p> : null}
      {failed && row.error ? <p role="alert" className="mt-1 text-xs text-cream/80">{row.error}</p> : null}
    </div>
    {!setup ? <span className={cn("shrink-0 text-xs", failed ? "font-semibold text-cream" : "text-smoke")}>{status}</span> : null}
  </li>;
}

function CleanupRow({ state }: { state: CompoundAllState }) {
  const status = state.cleanup.status;
  const unconfirmed = status === "failed" && state.cleanup.outcomeUnconfirmed;
  const failed = status === "failed" && !unconfirmed;
  return <li data-testid="compound-all-cleanup-row" data-status={status} className="flex items-start gap-3 px-4 py-3">
    <span className="mt-0.5 flex shrink-0"><StatusIcon status={status === "done" ? "done" : failed ? "failed" : unconfirmed ? "confirming" : status} /></span>
    <div className="min-w-0 flex-1">
      <p className="text-sm font-semibold text-cream">{COPY.cleanupRow}</p>
      <p className="text-xs text-smoke">{COPY.cleanupDetail}</p>
      {status === "failed" && state.cleanup.error ? <p role="alert" className="mt-1 text-xs text-cream/80">{state.cleanup.error}</p> : null}
    </div>
    {state.phase !== "setup" ? <span className={cn("shrink-0 text-xs", failed ? "font-semibold text-cream" : "text-smoke")}>{cleanupStatusLabel(status, state.cleanup.outcomeUnconfirmed)}</span> : null}
  </li>;
}

function Summary({ state }: { state: CompoundAllState }) {
  const summary = summarizeCompoundAll(state);
  const items = summaryItems(state);
  return <div data-testid="compound-all-summary" className="mt-3">
    <p role="status" className="text-sm font-semibold text-cream">{summaryHeading(state)}</p>
    <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.map(([label, value]) => <div key={label} className="rounded-2xl border border-white/10 p-3">
        <dt className="text-xs text-smoke">{label}</dt><dd className="mt-0.5 text-lg font-semibold tabular-nums text-cream">{value}</dd></div>)}
    </dl>
    {summary.recoveryPath ? <p data-testid="compound-all-recovery" className="mt-3 text-xs text-cream/80">{COPY.recoveryDetail}{" "}
      <Link href={summary.recoveryPath} className="font-semibold text-cream underline underline-offset-2">{COPY.recovery}</Link></p> : null}
  </div>;
}

function Controls({ state, actions, onClose, approvalsTotal }: { state: CompoundAllState; actions: CompoundAllActions; onClose: () => void; approvalsTotal: number }) {
  const failedRow = state.phase === "paused-failure" ? state.rows.find((row) => row.key === state.active) : undefined;
  const bar = (children: ReactNode, testId: string) => <div data-testid={testId} className="mt-5 flex flex-wrap gap-2 [&>button]:flex-1">{children}</div>;
  switch (state.phase) {
    case "setup":
      return bar(<>
        <button type="button" className={secondary} onClick={onClose}>Cancel</button>
        <button type="button" data-testid="compound-all-start" className={primary} disabled={approvalsTotal === 0} onClick={actions.start}>Start</button>
      </>, "compound-all-controls");
    case "running":
      if (state.rowsComplete) return null;
      return bar(<button type="button" data-testid="compound-all-stop" className={secondary} disabled={state.cancelRequested} onClick={actions.cancel}>
        {state.active ? COPY.stopAfterThis : "Stop"}</button>, "compound-all-controls");
    case "paused-checkpoint": {
      const done = state.rows.filter((row) => row.selected && (row.status === "done" || row.status === "skipped")).length;
      return <div data-testid="compound-all-checkpoint" className="mt-5 rounded-2xl border border-white/15 bg-white/[0.04] p-4">
        <p className="flex items-center gap-2 text-sm font-semibold text-cream"><Pause aria-hidden="true" className="size-4" />{COPY.checkpoint(done)}</p>
        {bar(<>
          <button type="button" className={secondary} onClick={actions.cancel}>Stop</button>
          <button type="button" data-testid="compound-all-continue" className={primary} onClick={actions.continue}>Continue</button>
        </>, "compound-all-controls")}
      </div>;
    }
    case "paused-failure":
      return <div data-testid="compound-all-failure" className="mt-5 rounded-2xl border border-white/20 bg-white/[0.04] p-4">
        <p className="text-sm font-semibold text-cream">{failedRow && rowResultUnconfirmed(failedRow) ? COPY.unconfirmed
          : `${COPY.didNotCompound}${failedRow?.retryable ? COPY.retryOrSkip : COPY.skipOnly}`}</p>
        {bar(<>
          <button type="button" className={secondary} onClick={actions.cancel}>Stop</button>
          <button type="button" data-testid="compound-all-skip" className={secondary} onClick={actions.skip}>Skip</button>
          {failedRow?.retryable ? <button type="button" data-testid="compound-all-retry" className={primary} onClick={actions.retry}>Retry</button> : null}
        </>, "compound-all-controls")}
      </div>;
    case "cleanup-offered":
    case "paused-cleanup-failure": {
      const unconfirmed = state.phase === "paused-cleanup-failure" && state.cleanup.outcomeUnconfirmed;
      return <div data-testid="compound-all-cleanup-offer" className="mt-5 rounded-2xl border border-white/15 bg-white/[0.04] p-4">
        <p className="text-sm text-cream/80">{unconfirmed ? "The cleanup is still confirming." : state.phase === "paused-cleanup-failure" ? "The cleanup did not complete." : "Compounds stopped."}{" "}
          {unconfirmed ? "Skip it and use the " : "Run the cleanup now, or skip it and use the "}
          <Link href={COMPOUND_ALL_RECOVERY_PATH} className="font-semibold text-cream underline underline-offset-2">recovery page</Link> later.</p>
        {bar(<>
          <button type="button" data-testid="compound-all-skip-cleanup" className={secondary} onClick={actions.skipCleanup}>Skip cleanup</button>
          {unconfirmed ? null : <button type="button" data-testid="compound-all-run-cleanup" className={primary} onClick={actions.runCleanup}>{state.phase === "paused-cleanup-failure" ? "Retry cleanup" : "Run cleanup"}</button>}
        </>, "compound-all-controls")}
      </div>;
    }
    case "finished":
    case "cancelled":
      return bar(<button type="button" data-testid="compound-all-close" className={primary} onClick={onClose}>Close</button>, "compound-all-controls");
  }
}

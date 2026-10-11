"use client";

import { LoaderCircle } from "lucide-react";
import type { OpenRangePreset, OpenRangeUiPreset } from "@/lib/open-range-presets";
import { BEST_HELP, BEST_LABEL, APR_ESTIMATE_CAVEAT, APR_ESTIMATE_LABEL } from "@/lib/range-apr/copy";
import { formatEstimate, unavailableReasonText } from "@/lib/range-apr/format";
import { MICRO_PRESET_ID, microBandLabel } from "@/lib/range-apr/micro-range";
import { buildPresetList, type BestButton } from "@/lib/range-apr/preset-list";
import { estimateForSelection, type SelectionEstimate, type TickRange } from "@/lib/range-apr/selection";
import { BrandMark } from "../brand-mark";
import { InfoTip } from "../info-tip";
import type { PoolRangeAprState } from "./use-pool-range-apr";

const BAND = "text-[10px] tabular-nums text-smoke";
const FOCUS = "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream/70";
// Every range button is 48px tall; the ones that share a row split it into equal columns.
const CELL = `flex h-12 min-w-0 flex-col items-center justify-center gap-0.5 rounded-2xl border px-0.5 transition-colors ${FOCUS}`;
const cellTone = (active: boolean) => (active
  ? "border-cream bg-white/[0.08] text-cream"
  : "border-white/20 text-smoke hover:border-white/40 hover:text-cream/90");

/** A candidate range the user has not selected, with its estimate (compared inside the APR card). */
type OtherRange = { id: string; name: string; text: string };

function Headline({ apr, selection, best, others }: {
  apr: PoolRangeAprState; selection: SelectionEstimate | null; best: BestButton | null; others: readonly OtherRange[];
}) {
  let value = "—";
  let estimated = false;
  let detail: string | null = null;
  if (apr.status === "loading") {
    value = "Estimating…";
  } else if (apr.status === "error") {
    detail = "Estimate unavailable right now. Creating a position is not affected.";
  } else if (apr.status === "ready" && selection) {
    if (selection.status === "incomplete") detail = "Enter a min and max price to see an estimate.";
    else if (selection.status === "invalid") detail = unavailableReasonText("invalid-range");
    else if (selection.estimate.status === "unavailable") detail = unavailableReasonText(selection.estimate.reason);
    else {
      value = formatEstimate(selection.estimate);
      estimated = true;
      detail = `About ${selection.estimate.inRangeVolumePct.toFixed(0)}% of recent volume traded inside this range. For a ~$${apr.data.referenceCapitalUsd} deposit; assumes price stays in range.`;
    }
  }
  return (
    <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-xs" aria-live="polite">
      <p className="flex items-center gap-1.5 text-smoke">
        {APR_ESTIMATE_LABEL}
        <InfoTip label={`About ${APR_ESTIMATE_LABEL}`}>{APR_ESTIMATE_CAVEAT}</InfoTip>
      </p>
      <p
        className={`mt-2 flex h-7 items-center gap-2 tabular-nums ${apr.status === "loading"
          ? "text-sm text-smoke"
          : `text-[1.75rem] font-medium leading-none tracking-[-0.035em] ${estimated ? "text-cream" : "text-smoke"}`}`}
        data-testid="range-apr-headline"
      >
        {apr.status === "loading" && <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
        {value}
      </p>
      {detail && <p className="mt-2 text-[11px] leading-5 text-smoke">{detail}</p>}
      {apr.status === "ready" && apr.data.sample.confidence === "low" && (
        <p className="mt-1 text-[11px] leading-5 text-smoke">Low confidence: thin or patchy recent trading, so treat this as a rough guide.</p>
      )}
      {best && (
        <p className="mt-1 text-[11px] leading-5 text-smoke">
          {BEST_LABEL} for this pool is {best.resolvedLabel}: the highest estimated fee APR of the candidate ranges over the last 7 days. Not a prediction.
        </p>
      )}
      {others.length > 0 && (
        <p className="mt-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-white/12 pt-3 text-smoke">
          Other ranges
          <span className="flex flex-wrap gap-x-4 gap-y-1">
            {others.map((other) => (
              <span key={other.id} className="inline-flex items-baseline gap-1.5">
                {other.name}
                <span className="tabular-nums text-cream/80" data-testid={`apr-${other.id}`}>{other.text}</span>
              </span>
            ))}
          </span>
        </p>
      )}
    </div>
  );
}

export function RangePresetPicker({
  presets, selected, onSelect, minPrice, maxPrice, onMinPrice, onMaxPrice, apr, quotedRange,
}: {
  presets: readonly OpenRangeUiPreset[];
  selected: OpenRangePreset;
  onSelect: (preset: OpenRangePreset) => void;
  minPrice: string;
  maxPrice: string;
  onMinPrice: (value: string) => void;
  onMaxPrice: (value: string) => void;
  apr: PoolRangeAprState;
  /** Aligned ticks of the live quote for the current selection, when one exists. */
  quotedRange: TickRange | null;
}) {
  const data = apr.status === "ready" ? apr.data : null;
  const selection = data ? estimateForSelection(data, { preset: selected, minPrice, maxPrice }, quotedRange) : null;
  // While loading / on error `data` is null, so this is the plain row without "Best" (and no highlight on it).
  const list = buildPresetList(presets, data);
  const best = list.best;
  const bestActive = selected === best?.id;
  const preset = (id: OpenRangeUiPreset["id"]) => presets.find((item) => item.id === id);
  // Micro is defined in tick-spacing steps; with the pool known it is shown as a percent like the others.
  const band = (id: OpenRangeUiPreset["id"]) => (id === MICRO_PRESET_ID && data ? microBandLabel(data.pool.tickSpacing) : preset(id)?.band);
  // The estimates live in one place, the APR card: its headline is the selection, and the rest are listed under it.
  const candidates = [
    ...(best ? [{ id: best.id, name: best.resolvedLabel, estimate: best.estimate }] : []),
    ...list.buttons.map((button) => ({ id: button.id, name: preset(button.id)?.shortLabel ?? button.label, estimate: button.estimate })),
  ];
  const others: OtherRange[] = candidates.some((candidate) => candidate.estimate?.status === "ok")
    ? candidates.filter((candidate) => candidate.id !== selected)
      .map((candidate) => ({ id: candidate.id, name: candidate.name, text: formatEstimate(candidate.estimate) }))
    : [];
  const tips = [
    ...(best ? [{ key: "best", label: `About ${BEST_LABEL}`, text: BEST_HELP }] : []),
    ...presets.filter((item) => item.help).map((item) => ({ key: item.id, label: `About ${item.shortLabel}`, text: item.help })),
  ];

  return (
    <>
      <div className="mt-4 flex items-center gap-1.5 text-xs text-smoke">
        <span>Price range (B per 1 A)</span>
        {tips.map((tip) => <InfoTip key={tip.key} label={tip.label}>{tip.text}</InfoTip>)}
      </div>
      <div className="mt-2 space-y-2" role="group" aria-label="Price range presets">
        {best ? (
          <div className="relative">
            <span
              aria-hidden="true"
              className={`pointer-events-none absolute inset-0 rounded-2xl bg-lemon opacity-[calc(var(--halo)*0.8)] blur-lg motion-safe:animate-halo ${bestActive ? "[--halo:0.7]" : "[--halo:0.3]"}`}
            />
            <button
              type="button"
              aria-pressed={bestActive}
              onClick={() => onSelect(best.id)}
              className={`relative flex h-12 w-full items-center gap-2.5 rounded-2xl border bg-char bg-linear-to-r from-lemon/15 to-transparent to-60% pl-2.5 pr-4 transition-colors ${FOCUS} ${bestActive
                ? "border-lemon text-cream"
                : "border-lemon/40 text-cream/80 hover:border-lemon/70 hover:text-cream"}`}
              data-testid="preset-best"
            >
              <BrandMark className="h-7 w-7 shrink-0 rounded-full bg-lemon p-1 text-ink shadow-[0_0_14px_rgb(243_231_107/0.55)]" />
              <span className="text-sm font-semibold">{BEST_LABEL}</span>
              <span className="ml-auto flex min-w-0 items-baseline gap-2">
                <span className="text-xs font-semibold" data-testid="best-resolved">{best.resolvedLabel}</span>
                <span className={BAND}>{band(best.id)}</span>
              </span>
            </button>
          </div>
        ) : apr.status === "loading" ? (
          // Holds the Best row's place so the form does not jump when the estimate arrives.
          <div className="flex h-12 items-center gap-2.5 rounded-2xl border border-white/10 pl-2.5 pr-4 text-xs text-smoke">
            <BrandMark className="h-7 w-7 shrink-0 rounded-full bg-white/10 p-1 motion-safe:animate-spin motion-safe:[animation-duration:2.4s]" />
            Finding the best range…
          </div>
        ) : null}
        <div className="grid auto-cols-fr grid-flow-col gap-1.5 sm:gap-2">
          {list.buttons.map((button) => (
            <button
              key={button.id}
              type="button"
              aria-pressed={selected === button.id}
              onClick={() => onSelect(button.id)}
              className={`${CELL} ${cellTone(selected === button.id)}`}
              data-testid={`preset-${button.id}`}
            >
              <span className="max-w-full truncate text-xs font-semibold leading-4">{preset(button.id)?.shortLabel ?? button.label}</span>
              <span className={`leading-3 ${BAND}`}>{band(button.id)}</span>
            </button>
          ))}
          <button
            type="button"
            aria-pressed={selected === "custom"}
            onClick={() => onSelect("custom")}
            className={`${CELL} ${cellTone(selected === "custom")}`}
            data-testid="preset-custom"
          >
            <span className="max-w-full truncate text-xs font-semibold leading-4">Custom</span>
            <span className={`leading-3 ${BAND}`}>Min–max</span>
          </button>
        </div>
      </div>
      {selected === "custom" && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <input
            aria-label="Minimum price"
            className="rounded-2xl border border-white/20 bg-white/[0.06] px-3 py-2 text-sm text-cream"
            value={minPrice}
            onChange={(event) => onMinPrice(event.target.value)}
            placeholder="Min"
          />
          <input
            aria-label="Maximum price"
            className="rounded-2xl border border-white/20 bg-white/[0.06] px-3 py-2 text-sm text-cream"
            value={maxPrice}
            onChange={(event) => onMaxPrice(event.target.value)}
            placeholder="Max"
          />
        </div>
      )}
      <Headline apr={apr} selection={selection} best={bestActive ? best : null} others={others} />
    </>
  );
}

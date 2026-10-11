"use client";

import { LoaderCircle } from "lucide-react";
import type { OpenRangePreset, OpenRangeUiPreset } from "@/lib/open-range-presets";
import { AI_BEST_HELP, AI_BEST_LABEL, APR_ESTIMATE_CAVEAT, APR_ESTIMATE_LABEL } from "@/lib/range-apr/copy";
import { formatEstimate, unavailableReasonText } from "@/lib/range-apr/format";
import { buildPresetList, type AiBestButton } from "@/lib/range-apr/preset-list";
import { estimateForSelection, type SelectionEstimate, type TickRange } from "@/lib/range-apr/selection";
import { InfoTip } from "../info-tip";
import type { PoolRangeAprState } from "./use-pool-range-apr";

const PILL = "rounded-2xl border px-3 py-1.5 text-left transition-colors";
const pillTone = (active: boolean) => (active ? "border-cream text-cream" : "border-white/20 text-smoke hover:border-white/40");

function aprLine(apr: PoolRangeAprState, text: string): string {
  return apr.status === "loading" ? "…" : text;
}

function Headline({ apr, selection, aiBest }: {
  apr: PoolRangeAprState; selection: SelectionEstimate | null; aiBest: AiBestButton | null;
}) {
  const label = (
    <span className="inline-flex items-center gap-1.5 text-smoke">
      {APR_ESTIMATE_LABEL}
      <InfoTip label={`About ${APR_ESTIMATE_LABEL}`}>{APR_ESTIMATE_CAVEAT}</InfoTip>
    </span>
  );
  let value = "—";
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
      detail = `About ${selection.estimate.inRangeVolumePct.toFixed(0)}% of recent volume traded inside this range. For a ~$${apr.data.referenceCapitalUsd} deposit; assumes price stays in range.`;
    }
  }
  return (
    <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-xs" aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        {label}
        <span className="inline-flex items-center gap-2 font-semibold tabular-nums text-cream" data-testid="range-apr-headline">
          {apr.status === "loading" && <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
          {value}
        </span>
      </div>
      {detail && <p className="mt-1 text-[11px] leading-5 text-smoke">{detail}</p>}
      {apr.status === "ready" && apr.data.sample.confidence === "low" && (
        <p className="mt-1 text-[11px] leading-5 text-smoke">Low confidence: thin or patchy recent trading, so treat this as a rough guide.</p>
      )}
      {aiBest && (
        <p className="mt-1 text-[11px] leading-5 text-smoke">
          {AI_BEST_LABEL} for this pool is {aiBest.resolvedLabel}: the highest estimated fee APR of the candidate ranges over the last 7 days. Not a prediction.
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
  // While loading / on error `data` is null, so this is the plain row without "AI best" (and no highlight on it).
  const list = buildPresetList(presets, data);
  const customText = selected === "custom" && selection?.status === "ready" ? formatEstimate(selection.estimate) : "—";
  const tips = [
    ...(list.aiBest ? [{ key: "ai-best", label: `About ${AI_BEST_LABEL}`, text: AI_BEST_HELP }] : []),
    ...presets.filter((preset) => preset.help).map((preset) => ({ key: preset.id, label: `About ${preset.shortLabel}`, text: preset.help })),
  ];

  return (
    <>
      <div className="mt-4 flex items-center gap-1.5 text-xs text-smoke">
        <span>Price range (B per 1 A)</span>
        {tips.map((tip) => <InfoTip key={tip.key} label={tip.label}>{tip.text}</InfoTip>)}
      </div>
      <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Price range presets">
        {list.aiBest && (
          <button
            type="button"
            aria-pressed={selected === list.aiBest.id}
            onClick={() => onSelect(list.aiBest!.id)}
            className={`${PILL} ${pillTone(selected === list.aiBest.id)}`}
            data-testid="preset-ai-best"
          >
            <span className="block text-xs font-semibold">{AI_BEST_LABEL}</span>
            <span className="block text-[10px] tabular-nums text-smoke" data-testid="apr-ai-best">{formatEstimate(list.aiBest.estimate)}</span>
            <span className="block text-[10px] text-smoke" data-testid="ai-best-resolved">{list.aiBest.resolvedLabel}</span>
          </button>
        )}
        {list.buttons.map((preset) => (
          <button
            key={preset.id}
            type="button"
            aria-pressed={selected === preset.id}
            onClick={() => onSelect(preset.id)}
            className={`${PILL} ${pillTone(selected === preset.id)}`}
          >
            <span className="block text-xs font-semibold">{preset.label}</span>
            <span className="block text-[10px] tabular-nums text-smoke" data-testid={`apr-${preset.id}`}>{aprLine(apr, formatEstimate(preset.estimate))}</span>
          </button>
        ))}
        <button
          type="button"
          aria-pressed={selected === "custom"}
          onClick={() => onSelect("custom")}
          className={`${PILL} ${pillTone(selected === "custom")}`}
        >
          <span className="block text-xs font-semibold">Custom</span>
          <span className="block text-[10px] tabular-nums text-smoke" data-testid="apr-custom">{aprLine(apr, customText)}</span>
        </button>
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
      <Headline apr={apr} selection={selection} aiBest={selected === list.aiBest?.id ? list.aiBest : null} />
    </>
  );
}

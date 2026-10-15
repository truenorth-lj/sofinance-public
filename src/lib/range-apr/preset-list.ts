import "@/lib/engine-host";
/**
 * Which range is "Best", and which buttons sit next to it (pure; shared by the Create position modal
 * and the pair cards so both always agree).
 *
 * "Best" is the candidate with the highest estimated fee APR, ties going to the wider
 * range. It resolves to that candidate's exact ticks, so quote/prepare use the ordinary preset path and what
 * is signed is what was priced.
 */
import type { OpenRangeUiPreset } from "@sofinance/engine/open-range-presets";
import type { RangeAprEstimate } from "./range-apr";
import type { PoolRangeAprPayload, RangeAprPresetEstimate, RangeAprPresetId } from "./types";

const TIE_RELATIVE_EPSILON = 1e-9;

type OkPreset = RangeAprPresetEstimate & { estimate: Extract<RangeAprEstimate, { status: "ok" }> };

const isOk = (preset: RangeAprPresetEstimate): preset is OkPreset => preset.estimate.status === "ok";
const width = (preset: RangeAprPresetEstimate) => preset.tickUpper - preset.tickLower;
const sameRange = (left: RangeAprPresetEstimate, right: RangeAprPresetEstimate) =>
  left.tickLower === right.tickLower && left.tickUpper === right.tickUpper;

/**
 * Candidate with the highest estimated APR among those with a usable estimate; ties (equal within float
 * noise) prefer the wider range, and between identical ranges the later one in `order` (the wider name).
 * Null when no candidate has an estimate.
 */
export function pickHighestAprPreset(
  candidates: readonly RangeAprPresetEstimate[],
  order: readonly RangeAprPresetId[] = ["micro", "tight", "standard", "wide"],
): RangeAprPresetEstimate | null {
  let winner: OkPreset | null = null;
  const rank = (preset: RangeAprPresetEstimate) => order.indexOf(preset.id);
  for (const candidate of candidates.filter(isOk)) {
    if (!winner) {
      winner = candidate;
      continue;
    }
    const a = candidate.estimate.aprPct;
    const b = winner.estimate.aprPct;
    const tied = Math.abs(a - b) <= TIE_RELATIVE_EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
    if (tied
      ? width(candidate) > width(winner) || (width(candidate) === width(winner) && rank(candidate) > rank(winner))
      : a > b) {
      winner = candidate;
    }
  }
  return winner;
}

export type BestButton = {
  /** The preset the button selects (what the quote API receives). */
  id: RangeAprPresetId;
  /** Short name of the range it resolved to, e.g. "Tight". */
  resolvedLabel: string;
  estimate: RangeAprEstimate;
};

export type PresetButton = { id: OpenRangeUiPreset["id"]; label: string; estimate: RangeAprEstimate | null };

export type PresetList = {
  /** Leftmost button; null while loading, on error, or when no candidate has an estimate. */
  best: BestButton | null;
  /** The remaining candidates, narrow to wide, without the resolved one. "Custom" is appended by the UI. */
  buttons: PresetButton[];
};

/**
 * Preset row for the modal. Without usable data it is the plain row (Micro, Tight, Standard, Wide) and no
 * "Best". With data, the resolved candidate is moved into "Best" and removed from the rest, along with
 * any candidate that covers exactly the same ticks (so no two buttons ever select the same range).
 */
export function buildPresetList(
  uiPresets: readonly OpenRangeUiPreset[], payload: PoolRangeAprPayload | null,
): PresetList {
  const degraded = payload?.sample.degraded === true;
  const estimateOf = (id: OpenRangeUiPreset["id"]): RangeAprEstimate | null =>
    degraded ? { status: "unavailable", reason: "degraded-data" }
      : payload?.presets.find((preset) => preset.id === id)?.estimate ?? null;
  // A degraded payload (no price history) is never ranked or shown with numbers, even if a caller hands over estimates.
  const order = uiPresets.map((preset) => preset.id) as RangeAprPresetId[];
  const winner = payload && !degraded ? pickHighestAprPreset(payload.presets, order) : null;
  if (!payload || !winner) {
    return { best: null, buttons: uiPresets.map((preset) => ({ id: preset.id, label: preset.label, estimate: estimateOf(preset.id) })) };
  }
  const resolved = uiPresets.find((preset) => preset.id === winner.id);
  return {
    best: { id: winner.id, resolvedLabel: resolved?.shortLabel ?? winner.id, estimate: winner.estimate },
    buttons: uiPresets
      .filter((preset) => {
        if (preset.id === winner.id) return false;
        const candidate = payload.presets.find((item) => item.id === preset.id);
        return !candidate || !sameRange(candidate, winner);
      })
      .map((preset) => ({ id: preset.id, label: preset.label, estimate: estimateOf(preset.id) })),
  };
}

/** What a pair card shows for its pool: the highest-APR candidate and its estimate, or null. */
export function highestRangeSummary(
  uiPresets: readonly OpenRangeUiPreset[], payload: PoolRangeAprPayload,
): { id: RangeAprPresetId; label: string; aprPct: number } | null {
  const { best } = buildPresetList(uiPresets, payload);
  return best && best.estimate.status === "ok"
    ? { id: best.id, label: best.resolvedLabel, aprPct: best.estimate.aprPct }
    : null;
}

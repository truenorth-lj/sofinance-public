import type { OpenPositionSummary } from "./open-types";

export type OpenBeamStatus = { landedLabel: string | null; tipNote: string | null };

export const NO_BEAM_STATUS: OpenBeamStatus = { landedLabel: null, tipNote: null };

/**
 * What the open-position modal says about Beam after a broadcast. The landed
 * label comes from the broadcast response (Solami swqos lookup); the note
 * explains a missing tip using the prepare summary so a recording is never
 * silently Beam-less.
 */
export function openBeamStatus(beam: OpenPositionSummary["beam"], beamLabel: string | null | undefined): OpenBeamStatus {
  const landedLabel = beamLabel?.trim() || null;
  if (landedLabel) return { landedLabel, tipNote: null };
  if (!beam) return { landedLabel: null, tipNote: null };
  if (beam.included) return { landedLabel: null, tipNote: "Beam tip included; landing proof not available yet." };
  const reason = beam.skippedReason === "oversize" ? "transaction too large for a tip"
    : beam.skippedReason === "no-tip-address" ? "no Beam tip address available"
      : "Beam disabled";
  return { landedLabel: null, tipNote: `Sent without Beam tip (${reason}).` };
}

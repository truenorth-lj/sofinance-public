import "@/lib/engine-host";
import { beamLandingUrl, fetchBeamLanding, formatBeamLanding, type BeamLanding } from "@sofinance/engine/solami-beam";

/** Upper bound for the single inline Beam landing lookup after a tipped broadcast. */
export const BEAM_INLINE_LOOKUP_TIMEOUT_MS = 1_000;

export type BeamAfterSend = {
  beam: BeamLanding | null;
  label: string | null;
  beamLandingUrl: string;
};

/** Response fields for a broadcast with no Beam landing info (yet). */
export function noBeamAfterSend(signature: string): BeamAfterSend {
  return { beam: null, label: null, beamLandingUrl: beamLandingUrl(signature) };
}

type BeamPlanLike = { included?: boolean | null } | null | undefined;

/**
 * Landing metadata after a broadcast that the RPC already accepted. Never
 * delays the response for an untipped transaction (no lookup at all), and for
 * a tipped one makes a single attempt capped at `BEAM_INLINE_LOOKUP_TIMEOUT_MS`.
 * Never throws; clients can poll `/api/beam-landing` for a later label.
 */
export async function beamAfterSend(
  signature: string,
  plan: BeamPlanLike,
  options: { fetcher?: typeof fetch; timeoutMs?: number } = {},
): Promise<BeamAfterSend> {
  const url = beamLandingUrl(signature);
  if (!plan?.included) return noBeamAfterSend(signature);
  const timeoutMs = options.timeoutMs ?? BEAM_INLINE_LOOKUP_TIMEOUT_MS;
  const base = options.fetcher ?? fetch;
  const fetcher: typeof fetch = (input, init) => {
    const signal = init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    return base(input, { ...init, signal });
  };
  try {
    const landing = await fetchBeamLanding(signature, { fetcher });
    return {
      beam: landing,
      label: landing?.isLanded ? formatBeamLanding(landing) : null,
      beamLandingUrl: url,
    };
  } catch {
    return noBeamAfterSend(signature);
  }
}

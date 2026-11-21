import type { MultiplierReading } from "./types";

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** Effective ScaledUiAmount multiplier: `newMultiplier` once its timestamp has passed, otherwise `multiplier`. */
export function effectiveScaledUiMultiplier(
  config: { multiplier: number; newMultiplier: number; newMultiplierEffectiveTimestamp?: bigint | number | string | null },
  nowMs = Date.now(),
): number {
  const current = Number(config.multiplier);
  const next = Number(config.newMultiplier);
  const raw = config.newMultiplierEffectiveTimestamp;
  const ts = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
  if (isPositiveFinite(next) && Number.isFinite(ts) && ts > 0) {
    const ms = ts > 1e12 ? ts : ts * 1000;
    if (nowMs >= ms) return next;
  }
  return current;
}

/** Unknown is not equivalent to a mint verified to have no multiplier. */
export function multiplierAt(reading: MultiplierReading, nowMs: number): number | null {
  switch (reading.kind) {
    case "none": return 1;
    case "unknown": return null;
    case "scaled-ui": {
      if (!Number.isFinite(nowMs)) return null;
      const value = effectiveScaledUiMultiplier(reading.config, nowMs);
      return isPositiveFinite(value) ? value : null;
    }
    default: {
      const exhaustive: never = reading;
      return exhaustive;
    }
  }
}

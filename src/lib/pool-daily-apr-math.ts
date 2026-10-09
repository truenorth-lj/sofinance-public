import { estimateFeeAprPct } from "./rwa-pairing";
import { isIncompleteUtcDay, utcDate, utcDayStart, type DailyAprPoint } from "./apr-series";

export const POOL_DAILY_APR_LABEL = "Pool fee APR (daily, estimated)";

export const POOL_DAILY_APR_ASSUMPTIONS = [
  "Each point is (that UTC day's USD volume × pool feeRate ÷ that day's TVL) × 365 × 100.",
  "Volume: GeckoTerminal daily OHLCV (currency=usd). TVL: Raydium /pools/line/liquidity (≤30 daily points).",
  "feeRate: Raydium /pools/info/ids. This is not Raydium-published daily feeApr (API v3 has no daily feeApr series).",
  "Ignores concentrated range, IL, rewards, and LP vs protocol fee split. Days missing volume or TVL are gaps — not interpolated.",
  "The current incomplete UTC day is omitted (partial volume would understate APR).",
].join(" ");

export type RaydiumLiquidityLinePoint = {
  time: number;
  tvlUsd: number;
};

export type GeckoVolumePoint = {
  time: number;
  volumeUsd: number;
};

export type RaydiumPoolSnapshot = {
  feeRate: number | null;
  tvlUsd: number | null;
  dayVolumeUsd: number | null;
  dayVolumeFeeUsd: number | null;
  dayFeeApr: number | null;
  weekFeeApr: number | null;
  monthFeeApr: number | null;
};

export function parseRaydiumLiquidityLine(body: unknown): RaydiumLiquidityLinePoint[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const envelope = body as { success?: unknown; data?: unknown };
  if (envelope.success === false) return [];
  const data = envelope.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const line = (data as { line?: unknown }).line;
  if (!Array.isArray(line)) return [];
  const out: RaydiumLiquidityLinePoint[] = [];
  for (const row of line) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const rec = row as { time?: unknown; liquidity?: unknown };
    const time = asFiniteNumber(rec.time);
    const tvlUsd = asFiniteNumber(rec.liquidity);
    if (time === null || tvlUsd === null || tvlUsd < 0) continue;
    out.push({ time: utcDayStart(time), tvlUsd });
  }
  return out;
}

export function parseGeckoDailyVolumes(body: unknown): GeckoVolumePoint[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const attrs = (data as { attributes?: unknown }).attributes;
  if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) return [];
  const list = (attrs as { ohlcv_list?: unknown }).ohlcv_list;
  if (!Array.isArray(list)) return [];
  const out: GeckoVolumePoint[] = [];
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const time = asFiniteNumber(row[0]);
    const volumeUsd = asFiniteNumber(row[5]);
    if (time === null || volumeUsd === null || volumeUsd < 0) continue;
    out.push({ time: utcDayStart(time), volumeUsd });
  }
  return out;
}

export function parseRaydiumPoolSnapshot(body: unknown): RaydiumPoolSnapshot {
  const empty: RaydiumPoolSnapshot = {
    feeRate: null,
    tvlUsd: null,
    dayVolumeUsd: null,
    dayVolumeFeeUsd: null,
    dayFeeApr: null,
    weekFeeApr: null,
    monthFeeApr: null,
  };
  if (!body || typeof body !== "object" || Array.isArray(body)) return empty;
  const envelope = body as { success?: unknown; data?: unknown };
  if (envelope.success === false) return empty;
  const rows = envelope.data;
  const pool = Array.isArray(rows) ? rows[0] : null;
  if (!pool || typeof pool !== "object" || Array.isArray(pool)) return empty;
  const rec = pool as {
    feeRate?: unknown;
    tvl?: unknown;
    day?: { volume?: unknown; volumeFee?: unknown; feeApr?: unknown };
    week?: { feeApr?: unknown };
    month?: { feeApr?: unknown };
  };
  return {
    feeRate: asFiniteNumber(rec.feeRate),
    tvlUsd: asFiniteNumber(rec.tvl),
    dayVolumeUsd: asFiniteNumber(rec.day?.volume),
    dayVolumeFeeUsd: asFiniteNumber(rec.day?.volumeFee),
    dayFeeApr: asFiniteNumber(rec.day?.feeApr),
    weekFeeApr: asFiniteNumber(rec.week?.feeApr),
    monthFeeApr: asFiniteNumber(rec.month?.feeApr),
  };
}

/**
 * Daily estimated fee APR = (volumeUsd × feeRate / tvlUsd) × 365 × 100.
 * Same formula as `estimateFeeAprPct` used for 24h pair rows.
 * A day is a gap unless both volume and TVL are present and TVL > 0.
 */
export function buildPoolDailyAprPoints(input: {
  volumes: readonly GeckoVolumePoint[];
  tvl: readonly RaydiumLiquidityLinePoint[];
  snapshot: RaydiumPoolSnapshot;
  nowSeconds: number;
}): DailyAprPoint[] {
  const feeRate = input.snapshot.feeRate;
  const volumeByDay = new Map<number, number>();
  for (const row of input.volumes) volumeByDay.set(row.time, row.volumeUsd);
  const tvlByDay = new Map<number, number>();
  for (const row of input.tvl) tvlByDay.set(row.time, row.tvlUsd);

  const days = new Set<number>([...volumeByDay.keys(), ...tvlByDay.keys()]);
  const points: DailyAprPoint[] = [];
  for (const time of [...days].sort((a, b) => a - b)) {
    if (isIncompleteUtcDay(time, input.nowSeconds)) continue;
    const volumeUsd = volumeByDay.get(time) ?? null;
    const tvlUsd = tvlByDay.get(time) ?? null;
    const feesUsd =
      volumeUsd !== null && feeRate !== null && feeRate >= 0 && Number.isFinite(feeRate)
        ? volumeUsd * feeRate
        : null;
    const aprPct =
      feesUsd !== null && tvlUsd !== null ? estimateFeeAprPct(feesUsd, tvlUsd) : null;
    points.push({
      time,
      date: utcDate(time),
      aprPct,
      volumeUsd,
      tvlUsd,
    });
  }
  return points;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

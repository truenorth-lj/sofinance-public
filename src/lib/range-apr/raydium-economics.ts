/** Pool-level economics from Raydium API v3 `/pools/info/ids` (pure parser). */
export type RaydiumPoolEconomics = {
  mintA: string;
  mintB: string;
  decimalsA: number;
  decimalsB: number;
  feeRate: number;
  tvlUsd: number;
  /** B per 1 A, UI units. */
  price: number;
  mintAmountA: number;
  mintAmountB: number;
  /** Parts per million of the trade fee; null when the config is not returned. */
  protocolFeeRate: number | null;
  fundFeeRate: number | null;
  weekVolumeUsd: number | null;
  dayFeeApr: number | null;
  weekFeeApr: number | null;
};

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function mintField(value: unknown): { address: string; decimals: number } | null {
  const record = value as { address?: unknown; decimals?: unknown } | null;
  if (!record || typeof record.address !== "string") return null;
  const decimals = num(record.decimals);
  return decimals === null ? null : { address: record.address, decimals };
}

export function parseRaydiumPoolEconomics(body: unknown): RaydiumPoolEconomics | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const envelope = body as { success?: unknown; data?: unknown };
  if (envelope.success === false || !Array.isArray(envelope.data)) return null;
  const pool = envelope.data[0] as Record<string, unknown> | null | undefined;
  if (!pool || typeof pool !== "object") return null;
  const mintA = mintField(pool.mintA);
  const mintB = mintField(pool.mintB);
  const feeRate = num(pool.feeRate);
  const tvlUsd = num(pool.tvl);
  const price = num(pool.price);
  const mintAmountA = num(pool.mintAmountA);
  const mintAmountB = num(pool.mintAmountB);
  if (!mintA || !mintB || feeRate === null || feeRate < 0 || tvlUsd === null || price === null ||
    mintAmountA === null || mintAmountB === null) return null;
  const config = (pool.config ?? {}) as Record<string, unknown>;
  const day = (pool.day ?? {}) as Record<string, unknown>;
  const week = (pool.week ?? {}) as Record<string, unknown>;
  return {
    mintA: mintA.address, mintB: mintB.address, decimalsA: mintA.decimals, decimalsB: mintB.decimals, feeRate, tvlUsd, price, mintAmountA, mintAmountB,
    protocolFeeRate: num(config.protocolFeeRate),
    fundFeeRate: num(config.fundFeeRate),
    weekVolumeUsd: num(week.volume),
    dayFeeApr: num(day.feeApr),
    weekFeeApr: num(week.feeApr),
  };
}

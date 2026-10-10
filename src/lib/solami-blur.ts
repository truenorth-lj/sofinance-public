import "server-only";

/**
 * Solami Blur REST client + defensive parsers.
 *
 * Verified live by the repo owner (not this agent runtime):
 *   GET /data/pool?chain=solana&address=<Raydium CLMM pool>
 *   GET /data/trades/recent?chain=solana&limit=N
 *   GET /data/pools?chain=solana&limit=N
 *
 * This environment has no SOLAMI_DATA_API_KEY, so live calls are not made
 * here. Parsers are fixture-tested against the documented / verified fields.
 */

export const SOLAMI_DATA_API_BASE = "https://api.solami.dev/data";
export const SOLAMI_BLUR_WS_BASE = "wss://ws.solami.dev/data/subscribe";
export const BLUR_EVENT_TYPES = "swap,liquidity" as const;

export type BlurPoolSnapshot = {
  pool: string;
  dex: string | null;
  mint: string | null;
  quoteMint: string | null;
  name: string | null;
  symbol: string | null;
  price: number | null;
  priceUsd: number | null;
  baseReserve: number | null;
  quoteReserve: number | null;
  liquidityUsd: number | null;
  tvlUsd: number | null;
  fees24hUsd: number | null;
  volumeTvlRatio: number | null;
  lpDeposit24hUsd: number | null;
  lpWithdraw24hUsd: number | null;
};

export type BlurTrade = {
  signature: string;
  slot: number | null;
  blockTime: number | null;
  dex: string | null;
  pool: string | null;
  side: string | null;
  trader: string | null;
  price: number | null;
  priceUsd: number | null;
  volumeUsd: number | null;
  baseAmount: number | null;
  quoteAmount: number | null;
  type: string | null;
};

export type PoolActivitySnapshot = {
  available: boolean;
  poolId: string;
  pool: BlurPoolSnapshot | null;
  trades: BlurTrade[];
  fetchedAt: string;
  source: "solami-blur" | "unavailable";
};

export type BlurEnv = Record<string, string | undefined>;

export function solamiDataApiKey(env: BlurEnv = process.env as BlurEnv): string {
  return env.SOLAMI_DATA_API_KEY?.trim() ?? "";
}

export function isBlurConfigured(env: BlurEnv = process.env as BlurEnv): boolean {
  return solamiDataApiKey(env).length > 0;
}

export function blurWsUrl(poolId: string, env: BlurEnv = process.env as BlurEnv): string | null {
  const key = solamiDataApiKey(env);
  if (!key) return null;
  const url = new URL(SOLAMI_BLUR_WS_BASE);
  url.searchParams.set("chain", "solana");
  url.searchParams.set("api_key", key);
  url.searchParams.set("type", BLUR_EVENT_TYPES);
  // Documented on https://solami.dev/docs/guide-stream-trades: `address=` narrows the socket.
  url.searchParams.set("address", poolId);
  return url.toString();
}

/** Filter payload sent after connect. `types` is documented; `pools`/`addresses` are extra narrowing. */
export function blurSubscribeFilter(poolId: string) {
  return {
    filter: {
      types: ["swap", "liquidity"],
      pools: [poolId],
      addresses: [poolId],
    },
  };
}

export function parseDecimal(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function parseInteger(value: unknown): number | null {
  const n = parseDecimal(value);
  return n === null ? null : Math.trunc(n);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function unwrapDataPayload(raw: unknown): unknown {
  const record = asRecord(raw);
  if (!record) return raw;
  if (Array.isArray(record.data)) return record.data;
  const nested = asRecord(record.data);
  if (nested) return nested;
  return raw;
}

export function parseBlurPoolSnapshot(raw: unknown, fallbackPool?: string): BlurPoolSnapshot | null {
  const record = asRecord(unwrapDataPayload(raw));
  if (!record) return null;
  const pool = asString(record.pool) ?? asString(record.address) ?? fallbackPool ?? null;
  if (!pool) return null;
  return {
    pool,
    dex: asString(record.dex),
    mint: asString(record.mint),
    quoteMint: asString(record.quote_mint) ?? asString(record.quoteMint),
    name: asString(record.name),
    symbol: asString(record.symbol),
    price: parseDecimal(record.price),
    priceUsd: parseDecimal(record.price_usd) ?? parseDecimal(record.priceUsd),
    baseReserve: parseDecimal(record.base_reserve) ?? parseDecimal(record.baseReserve),
    quoteReserve: parseDecimal(record.quote_reserve) ?? parseDecimal(record.quoteReserve),
    liquidityUsd: parseDecimal(record.liquidity_usd) ?? parseDecimal(record.liquidityUsd),
    tvlUsd: parseDecimal(record.tvl_usd) ?? parseDecimal(record.tvlUsd),
    fees24hUsd: parseDecimal(record.fees_24h_usd) ?? parseDecimal(record.fees24hUsd),
    volumeTvlRatio: parseDecimal(record.volume_tvl_ratio) ?? parseDecimal(record.volumeTvlRatio),
    lpDeposit24hUsd: parseDecimal(record.lp_deposit_24h_usd) ?? parseDecimal(record.lpDeposit24hUsd),
    lpWithdraw24hUsd: parseDecimal(record.lp_withdraw_24h_usd) ?? parseDecimal(record.lpWithdraw24hUsd),
  };
}

export function parseBlurTrade(raw: unknown): BlurTrade | null {
  const record = asRecord(raw);
  if (!record) return null;
  const signature = asString(record.signature);
  if (!signature) return null;
  return {
    signature,
    slot: parseInteger(record.slot),
    blockTime: parseInteger(record.block_time) ?? parseInteger(record.blockTime),
    dex: asString(record.dex),
    pool: asString(record.pool),
    side: asString(record.side),
    trader: asString(record.trader),
    price: parseDecimal(record.price),
    priceUsd: parseDecimal(record.price_usd) ?? parseDecimal(record.priceUsd),
    volumeUsd: parseDecimal(record.volume_usd) ?? parseDecimal(record.volumeUsd),
    baseAmount: parseDecimal(record.base_amount) ?? parseDecimal(record.baseAmount),
    quoteAmount: parseDecimal(record.quote_amount) ?? parseDecimal(record.quoteAmount),
    type: asString(record.type) ?? "swap",
  };
}

export function parseBlurTradeList(raw: unknown): BlurTrade[] {
  const payload = unwrapDataPayload(raw);
  const rows = Array.isArray(payload) ? payload : Array.isArray(asRecord(payload)?.trades)
    ? (asRecord(payload)!.trades as unknown[])
    : [];
  return rows.map(parseBlurTrade).filter((item): item is BlurTrade => item !== null);
}

export function filterTradesForPool(trades: readonly BlurTrade[], poolId: string): BlurTrade[] {
  return trades.filter((trade) => trade.pool === poolId);
}

export function eventMatchesPool(raw: unknown, poolId: string): boolean {
  const record = asRecord(raw);
  if (!record) return false;
  const pool = asString(record.pool) ?? asString(record.address);
  return pool === poolId;
}

export type BlurFetcher = (url: string, init?: RequestInit) => Promise<Response>;

async function blurGet(
  path: string,
  params: Record<string, string>,
  env: BlurEnv,
  fetcher: BlurFetcher,
): Promise<unknown> {
  const key = solamiDataApiKey(env);
  if (!key) throw new Error("SOLAMI_DATA_API_KEY is not configured");
  const url = new URL(`${SOLAMI_DATA_API_BASE}${path}`);
  url.searchParams.set("chain", "solana");
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const response = await fetcher(url.toString(), {
    headers: {
      Accept: "application/json",
      "x-api-key": key,
    },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Solami Blur ${path} returned ${response.status}`);
  }
  return response.json();
}

export async function fetchBlurPool(
  poolId: string,
  options: { env?: BlurEnv; fetcher?: BlurFetcher } = {},
): Promise<BlurPoolSnapshot | null> {
  const env = options.env ?? (process.env as BlurEnv);
  const fetcher = options.fetcher ?? fetch;
  const raw = await blurGet("/pool", { address: poolId }, env, fetcher);
  return parseBlurPoolSnapshot(raw, poolId);
}

export async function fetchBlurRecentTrades(
  poolId: string,
  limit: number,
  options: { env?: BlurEnv; fetcher?: BlurFetcher } = {},
): Promise<BlurTrade[]> {
  const env = options.env ?? (process.env as BlurEnv);
  const fetcher = options.fetcher ?? fetch;
  const capped = Math.min(Math.max(1, limit), 200);
  // `/data/trades/recent` is a chain-wide firehose (documented). We request a
  // page and filter to the pool. `address=` is tried first (WS uses it); a 400
  // retries without it so an unknown query key cannot break the snapshot.
  try {
    const raw = await blurGet("/trades/recent", { limit: String(capped), address: poolId }, env, fetcher);
    const filtered = filterTradesForPool(parseBlurTradeList(raw), poolId);
    if (filtered.length) return filtered.slice(0, capped);
  } catch {
    /* retry without address — the firehose docs do not list a pool query param */
  }
  const raw = await blurGet("/trades/recent", { limit: String(Math.min(200, Math.max(capped, 100))) }, env, fetcher);
  return filterTradesForPool(parseBlurTradeList(raw), poolId).slice(0, capped);
}

export async function getPoolActivitySnapshot(
  poolId: string,
  options: { limit?: number; env?: BlurEnv; fetcher?: BlurFetcher } = {},
): Promise<PoolActivitySnapshot> {
  const env = options.env ?? (process.env as BlurEnv);
  if (!isBlurConfigured(env)) {
    return {
      available: false,
      poolId,
      pool: null,
      trades: [],
      fetchedAt: new Date().toISOString(),
      source: "unavailable",
    };
  }
  const limit = options.limit ?? 20;
  const [pool, trades] = await Promise.all([
    fetchBlurPool(poolId, options).catch(() => null),
    fetchBlurRecentTrades(poolId, limit, options).catch(() => [] as BlurTrade[]),
  ]);
  return {
    available: true,
    poolId,
    pool,
    trades,
    fetchedAt: new Date().toISOString(),
    source: "solami-blur",
  };
}

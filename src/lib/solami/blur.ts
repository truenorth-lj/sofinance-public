import "server-only";
import { isSolamiEnabled } from "@/lib/protocol-flags";

/**
 * Solami Blur REST client + defensive parsers.
 *
 * Live-verified:
 *   GET /data/pool?chain=solana&address=<Raydium CLMM pool>  → includes `mint`
 *   GET /data/token/trades?chain=solana&address=<MINT>&limit=N
 *     (rows from every pool/DEX for that token; filter client-side by `pool`)
 *   WS  wss://ws.solami.dev/data/subscribe?chain=solana&type=swap,liquidity&pool=<POOL>&api_key=
 *     first frame `{ type: "connected", filter: { pools: 1, mints: 0, ... } }`
 *     `address=` is a MINT filter, not a pool filter
 *   `/data/pool/trades` and `/data/trades` are 404
 *   `/data/trades/recent` is a global firehose (does not honor address= or pool=)
 */

export const SOLAMI_DATA_API_BASE = "https://api.solami.dev/data";
export const SOLAMI_BLUR_WS_BASE = "wss://ws.solami.dev/data/subscribe";
export const BLUR_EVENT_TYPES = "swap,liquidity" as const;
export const TOKEN_TRADES_MAX_LIMIT = 200;

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
  ixIndex: number | null;
  innerIxIndex: number | null;
};

export type BlurLiveEvent = {
  kind: "swap" | "liquidity";
  trade: BlurTrade;
};

/**
 * Why a snapshot or stream is unavailable. Status codes only: never the key,
 * a URL (the WS URL carries the key), or an upstream body.
 * - `disabled`: SOLAMI_ENABLED (alias POOL_ACTIVITY_ENABLED) is off for this deployment; nothing was requested.
 * - `not-configured`: SOLAMI_DATA_API_KEY is unset; nothing was requested.
 * - `plan-<status>`: Solami refused the key for this plan (401/402/403/429).
 * - `http-<status>`: any other non-2xx from Solami.
 * - `upstream-error`: the request failed before a response (network, bad JSON).
 * - `no-data`: Solami answered but the pool payload had nothing usable.
 * - `upstream-close` / `websocket-unavailable`: stream only (see classifyBlurStreamClose).
 */
export type PoolActivityUnavailableReason =
  | "disabled"
  | "not-configured"
  | `plan-${number}`
  | `http-${number}`
  | "upstream-error"
  | "no-data"
  | "upstream-close"
  | "websocket-unavailable";

export type PoolActivitySnapshot = {
  available: boolean;
  poolId: string;
  pool: BlurPoolSnapshot | null;
  trades: BlurTrade[];
  fetchedAt: string;
  source: "solami-blur" | "unavailable";
  /** Present only when `available` is false. */
  reason?: PoolActivityUnavailableReason;
};

/** Thrown by the REST client; carries the HTTP status and nothing else from the response. */
export class BlurHttpError extends Error {
  readonly status: number;
  constructor(path: string, status: number) {
    super(`Solami Blur ${path} returned ${status} (${isBlurPlanHttpStatus(status) ? "plan" : "http"})`);
    this.name = "BlurHttpError";
    this.status = status;
  }
}

export function blurUnavailableReasonForStatus(status: number): PoolActivityUnavailableReason {
  return isBlurPlanHttpStatus(status) ? `plan-${status}` : `http-${status}`;
}

/** Sanitized one-line log: a fixed tag, the reason (status code only) and nothing else. */
export function logPoolActivityUnavailable(surface: "snapshot" | "stream", reason: PoolActivityUnavailableReason): void {
  if (reason === "disabled" || reason === "not-configured") return;
  // eslint-disable-next-line no-console -- sanitized: fixed tag + reason (status code only)
  console.warn(`[pool-activity] ${surface} unavailable: ${reason}`);
}

export function isBlurPlanHttpStatus(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429;
}

export function unavailablePoolActivitySnapshot(
  poolId: string,
  reason: PoolActivityUnavailableReason = "no-data",
): PoolActivitySnapshot {
  return {
    available: false,
    poolId,
    pool: null,
    trades: [],
    fetchedAt: new Date().toISOString(),
    source: "unavailable",
    reason,
  };
}

function poolSnapshotIsUseful(pool: BlurPoolSnapshot): boolean {
  return (
    pool.price !== null
    || pool.priceUsd !== null
    || pool.tvlUsd !== null
    || pool.liquidityUsd !== null
    || pool.fees24hUsd !== null
    || pool.mint !== null
  );
}

/**
 * Free-tier / lapsed Data API sockets often open then close immediately with
 * no `connected` frame and no swaps. Treat that as unavailable so the UI can
 * hide the live ticker instead of reconnecting into an empty stream.
 */
export function classifyBlurStreamClose(state: {
  socketOpened: boolean;
  receivedConnected: boolean;
  receivedLiveEvent: boolean;
  cause?: "error" | "close";
}): { event: "unavailable" | "end"; reason: "websocket-unavailable" | "upstream-close" | "upstream-error" } {
  if (!state.receivedConnected && !state.receivedLiveEvent) {
    if (!state.socketOpened || state.cause === "error") {
      return { event: "unavailable", reason: "websocket-unavailable" };
    }
    return { event: "unavailable", reason: "upstream-close" };
  }
  return { event: "end", reason: state.cause === "error" ? "upstream-error" : "upstream-close" };
}

export type BlurEnv = Record<string, string | undefined>;

export function solamiDataApiKey(env: BlurEnv = process.env as BlurEnv): string {
  return env.SOLAMI_DATA_API_KEY?.trim() ?? "";
}

export function isBlurConfigured(env: BlurEnv = process.env as BlurEnv): boolean {
  return solamiDataApiKey(env).length > 0;
}

export function blurWsUrl(poolId: string, env: BlurEnv = process.env as BlurEnv): string | null {
  if (!isSolamiEnabled()) return null; // SOLAMI_ENABLED off: never open a socket.
  const key = solamiDataApiKey(env);
  if (!key) return null;
  const url = new URL(SOLAMI_BLUR_WS_BASE);
  url.searchParams.set("chain", "solana");
  url.searchParams.set("api_key", key);
  url.searchParams.set("type", BLUR_EVENT_TYPES);
  // Live-verified: `pool=` is the pool filter (connected.filter.pools === 1).
  // `address=` is a mint filter — never pass a pool id there.
  url.searchParams.set("pool", poolId);
  return url.toString();
}

/** Extra narrowing after connect. Do not put the pool id in `addresses` (that is a mint filter). */
export function blurSubscribeFilter(poolId: string) {
  return {
    filter: {
      types: ["swap", "liquidity"],
      pools: [poolId],
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
    ixIndex: parseInteger(record.ix_index) ?? parseInteger(record.ixIndex),
    innerIxIndex: parseInteger(record.inner_ix_index) ?? parseInteger(record.innerIxIndex),
  };
}

export function parseBlurTradeList(raw: unknown): BlurTrade[] {
  const payload = unwrapDataPayload(raw);
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(asRecord(payload)?.trades)
      ? (asRecord(payload)!.trades as unknown[])
      : [];
  return rows.map(parseBlurTrade).filter((item): item is BlurTrade => item !== null);
}

export function filterTradesForPool(trades: readonly BlurTrade[], poolId: string): BlurTrade[] {
  return trades.filter((trade) => trade.pool === poolId);
}

/**
 * A swap emits two frames (base and quote sides, mint/quote_mint swapped)
 * with the same signature + ix_index (+ inner_ix_index).
 */
export function blurEventDedupeKey(trade: Pick<BlurTrade, "signature" | "ixIndex" | "innerIxIndex">): string {
  return `${trade.signature}:${trade.ixIndex ?? ""}:${trade.innerIxIndex ?? ""}`;
}

export function rememberBlurEvent(
  seen: Set<string>,
  trade: Pick<BlurTrade, "signature" | "ixIndex" | "innerIxIndex">,
): boolean {
  const key = blurEventDedupeKey(trade);
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

export function dedupeBlurTrades(trades: readonly BlurTrade[]): BlurTrade[] {
  const seen = new Set<string>();
  const out: BlurTrade[] = [];
  for (const trade of trades) {
    if (rememberBlurEvent(seen, trade)) out.push(trade);
  }
  return out;
}

export function eventMatchesPool(raw: unknown, poolId: string): boolean {
  const record = asRecord(raw);
  if (!record) return false;
  const pool = asString(record.pool);
  if (!pool) return false;
  return pool === poolId;
}

const LIVE_EVENT_TYPES = new Set(["swap", "liquidity"]);

export function isBlurConnectedFrame(raw: unknown): boolean {
  const record = asRecord(raw);
  return asString(record?.type) === "connected";
}

/**
 * Whitelist parsed swap/liquidity only. Drops `connected`, `metadata`
 * (metadata.image_url embeds `?api_key=` of the server key), and anything else.
 */
export function parseBlurLiveEvent(raw: unknown, poolId?: string): BlurLiveEvent | null {
  const record = asRecord(raw);
  if (!record) return null;
  const type = asString(record.type);
  if (!type || !LIVE_EVENT_TYPES.has(type)) return null;
  const trade = parseBlurTrade({ ...record, type });
  if (!trade) return null;
  if (poolId && trade.pool && trade.pool !== poolId) return null;
  return { kind: type as BlurLiveEvent["kind"], trade };
}

export function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function formatSseComment(text = "heartbeat"): string {
  return `: ${text}\n\n`;
}

/** True when an SSE chunk would leak a Solami key (`api_key=` or `sk_…`). */
export function sseChunkLeaksSecret(chunk: string): boolean {
  return /api_key/i.test(chunk) || /sk_/.test(chunk);
}

export function encodeSseEvent(event: string, data: unknown): string | null {
  const chunk = formatSseEvent(event, data);
  return sseChunkLeaksSecret(chunk) ? null : chunk;
}

export function tokenTradesFetchLimit(requested: number): number {
  const capped = Math.min(Math.max(1, requested), TOKEN_TRADES_MAX_LIMIT);
  return Math.min(TOKEN_TRADES_MAX_LIMIT, Math.max(capped * 5, 80));
}

export type BlurFetcher = (url: string, init?: RequestInit) => Promise<Response>;

async function blurGet(
  path: string,
  params: Record<string, string>,
  env: BlurEnv,
  fetcher: BlurFetcher,
): Promise<unknown> {
  if (!isSolamiEnabled()) throw new Error("Solami is disabled on this deployment");
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
  if (!response.ok) throw new BlurHttpError(path, response.status);
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

/**
 * Token-scoped trades (all pools/DEXes for `mint`), then keep rows whose
 * `pool` equals the requested pool id. `/data/trades/recent` is a global
 * feed and must not be used as a pool filter.
 */
export async function fetchBlurTokenTradesForPool(
  poolId: string,
  mint: string,
  limit: number,
  options: { env?: BlurEnv; fetcher?: BlurFetcher } = {},
): Promise<BlurTrade[]> {
  const env = options.env ?? (process.env as BlurEnv);
  const fetcher = options.fetcher ?? fetch;
  const capped = Math.min(Math.max(1, limit), TOKEN_TRADES_MAX_LIMIT);
  const raw = await blurGet(
    "/token/trades",
    { address: mint, limit: String(tokenTradesFetchLimit(capped)) },
    env,
    fetcher,
  );
  return dedupeBlurTrades(filterTradesForPool(parseBlurTradeList(raw), poolId)).slice(0, capped);
}

export async function getPoolActivitySnapshot(
  poolId: string,
  options: { limit?: number; env?: BlurEnv; fetcher?: BlurFetcher } = {},
): Promise<PoolActivitySnapshot> {
  if (!isSolamiEnabled()) return unavailablePoolActivitySnapshot(poolId, "disabled");
  const env = options.env ?? (process.env as BlurEnv);
  if (!isBlurConfigured(env)) {
    return unavailablePoolActivitySnapshot(poolId, "not-configured");
  }
  let pool: BlurPoolSnapshot | null;
  try {
    pool = await fetchBlurPool(poolId, options);
  } catch (error) {
    const reason = error instanceof BlurHttpError ? blurUnavailableReasonForStatus(error.status) : "upstream-error";
    logPoolActivityUnavailable("snapshot", reason);
    return unavailablePoolActivitySnapshot(poolId, reason);
  }
  if (!pool || !poolSnapshotIsUseful(pool)) return unavailablePoolActivitySnapshot(poolId, "no-data");
  const limit = options.limit ?? 20;
  // Trades are best-effort: the pool snapshot is still useful without them.
  const trades = pool.mint
    ? await fetchBlurTokenTradesForPool(poolId, pool.mint, limit, options).catch(() => [] as BlurTrade[])
    : [];
  return {
    available: true,
    poolId,
    pool,
    trades,
    fetchedAt: new Date().toISOString(),
    source: "solami-blur",
  };
}

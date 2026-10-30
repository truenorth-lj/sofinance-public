import { isAddressEqual, type Address, type Hex } from "viem";
import type { Univ4AllowlistedPool } from "./constants";
import { poolFeeAprPct } from "../../fee-apr";

/**
 * 24h volume and TVL for an allowlisted v4 pool from public indexers (PM decision 2026-10-29: no event scans
 * over RPC; RPC is used only for current state and at transaction time).
 *
 * - DexScreener `GET /latest/dex/pairs/robinhood/{poolId}` (documented limit 300 req/min, CDN max-age 30 s) is
 *   the primary source. v4 pairs are keyed by poolId.
 * - GeckoTerminal `GET /networks/robinhood/pools/{poolId}` (keyless: ~5–10 req/min per IP, cached 60 s) is the
 *   fallback, only when DexScreener fails.
 * Neither reports a fee tier for dynamic-fee (StablePairHook) pools, so the fee rate comes from the hook on chain.
 * Responses are validated against the allowlist (chain, poolId, both token addresses) before use.
 */
export type Univ4MarketSource = "dexscreener" | "geckoterminal";

export type Univ4MarketData = {
  source: Univ4MarketSource;
  volume24hUsd: number;
  tvlUsd: number;
  /** Swaps in the last 24h when the source reports them. */
  txns24h: number | null;
  /** Pool token balances as reported by the source (token units), when available. */
  reserves: { token0: number; token1: number } | null;
};

export const DEXSCREENER_CHAIN_ID = "robinhood";
export const GECKOTERMINAL_NETWORK = "robinhood";
export const dexScreenerPairUrl = (poolId: Hex) => `https://api.dexscreener.com/latest/dex/pairs/${DEXSCREENER_CHAIN_ID}/${poolId.toLowerCase()}`;
export const geckoTerminalPoolUrl = (poolId: Hex) => `https://api.geckoterminal.com/api/v2/networks/${GECKOTERMINAL_NETWORK}/pools/${poolId.toLowerCase()}`;

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};
const sameAddress = (a: unknown, b: Address) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && isAddressEqual(a as Address, b);

/** DexScreener pair payload → market data, or null when it is not exactly this pool. */
export function parseDexScreenerPair(payload: unknown, spec: Univ4AllowlistedPool): Univ4MarketData | null {
  if (!isObj(payload)) return null;
  const candidates = [payload.pair, ...(Array.isArray(payload.pairs) ? payload.pairs : [])];
  const pair = candidates.find(item => isObj(item) && item.chainId === DEXSCREENER_CHAIN_ID
    && typeof item.pairAddress === "string" && item.pairAddress.toLowerCase() === spec.poolId.toLowerCase());
  if (!isObj(pair) || !isObj(pair.baseToken) || !isObj(pair.quoteToken)) return null;
  const base = pair.baseToken.address, quote = pair.quoteToken.address;
  const baseIs0 = sameAddress(base, spec.currency0.address) && sameAddress(quote, spec.currency1.address);
  const baseIs1 = sameAddress(base, spec.currency1.address) && sameAddress(quote, spec.currency0.address);
  if (!baseIs0 && !baseIs1) return null;
  const volume24hUsd = isObj(pair.volume) ? num(pair.volume.h24) : null;
  const liquidity = isObj(pair.liquidity) ? pair.liquidity : null;
  const tvlUsd = liquidity ? num(liquidity.usd) : null;
  if (volume24hUsd === null || tvlUsd === null) return null;
  const txns = isObj(pair.txns) && isObj(pair.txns.h24) ? pair.txns.h24 : null;
  const buys = txns ? num(txns.buys) : null, sells = txns ? num(txns.sells) : null;
  const baseAmount = liquidity ? num(liquidity.base) : null, quoteAmount = liquidity ? num(liquidity.quote) : null;
  return {
    source: "dexscreener", volume24hUsd, tvlUsd,
    txns24h: buys !== null && sells !== null ? buys + sells : null,
    reserves: baseAmount !== null && quoteAmount !== null
      ? (baseIs0 ? { token0: baseAmount, token1: quoteAmount } : { token0: quoteAmount, token1: baseAmount }) : null,
  };
}

/** GeckoTerminal pool payload → market data, or null when it is not exactly this pool. */
export function parseGeckoTerminalPool(payload: unknown, spec: Univ4AllowlistedPool): Univ4MarketData | null {
  if (!isObj(payload) || !isObj(payload.data)) return null;
  const { id, attributes, relationships } = payload.data;
  if (id !== `${GECKOTERMINAL_NETWORK}_${spec.poolId.toLowerCase()}` || !isObj(attributes) || !isObj(relationships)) return null;
  const tokenId = (rel: unknown) => isObj(rel) && isObj(rel.data) && typeof rel.data.id === "string" ? rel.data.id.replace(`${GECKOTERMINAL_NETWORK}_`, "") : null;
  const tokens = [tokenId(relationships.base_token), tokenId(relationships.quote_token)];
  const expected = [spec.currency0.address, spec.currency1.address];
  if (!expected.every(address => tokens.some(token => sameAddress(token, address)))) return null;
  const volume24hUsd = isObj(attributes.volume_usd) ? num(attributes.volume_usd.h24) : null;
  const tvlUsd = num(attributes.reserve_in_usd);
  if (volume24hUsd === null || tvlUsd === null) return null;
  const tx = isObj(attributes.transactions) && isObj(attributes.transactions.h24) ? attributes.transactions.h24 : null;
  const buys = tx ? num(tx.buys) : null, sells = tx ? num(tx.sells) : null;
  return { source: "geckoterminal", volume24hUsd, tvlUsd, txns24h: buys !== null && sells !== null ? buys + sells : null, reserves: null };
}

/** One GeckoTerminal call for up to 30 pools (`/pools/multi/{a,b,…}`). */
export const geckoTerminalPoolsMultiUrl = (poolIds: readonly Hex[]) =>
  `https://api.geckoterminal.com/api/v2/networks/${GECKOTERMINAL_NETWORK}/pools/multi/${poolIds.map(id => id.toLowerCase()).join(",")}`;
/** One DexScreener call for up to 30 pairs. */
export const dexScreenerPairsUrl = (poolIds: readonly Hex[]) =>
  `https://api.dexscreener.com/latest/dex/pairs/${DEXSCREENER_CHAIN_ID}/${poolIds.map(id => id.toLowerCase()).join(",")}`;

/** GeckoTerminal `/pools/multi` payload → market data per allowlisted pool id (lowercase). Pools it lacks are absent. */
export function parseGeckoTerminalPools(payload: unknown, specs: readonly Univ4AllowlistedPool[]): Map<string, Univ4MarketData> {
  const out = new Map<string, Univ4MarketData>();
  const items = isObj(payload) && Array.isArray(payload.data) ? payload.data : [];
  for (const spec of specs) for (const item of items) {
    const parsed = parseGeckoTerminalPool({ data: item }, spec);
    if (parsed) { out.set(spec.poolId.toLowerCase(), parsed); break; }
  }
  return out;
}

/** DexScreener multi-pair payload → market data per allowlisted pool id (lowercase). */
export function parseDexScreenerPairs(payload: unknown, specs: readonly Univ4AllowlistedPool[]): Map<string, Univ4MarketData> {
  const out = new Map<string, Univ4MarketData>();
  for (const spec of specs) {
    const parsed = parseDexScreenerPair(payload, spec);
    if (parsed) out.set(spec.poolId.toLowerCase(), parsed);
  }
  return out;
}

export type FetchUniv4MarketOptions = {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  /** Skip the GeckoTerminal fallback (e.g. while its own cooldown is active). */
  allowFallback?: () => boolean;
  /** Called with 429 / failure info so the host can open a cooldown. Never receives URLs with secrets (none are used). */
  onUpstream?: (event: { source: Univ4MarketSource; outcome: "ok" | "error" | "rate-limited" | "mismatch" }) => void;
};

async function getJson(url: string, options: FetchUniv4MarketOptions): Promise<{ status: number; body: unknown }> {
  const response = await (options.fetcher ?? fetch)(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
  });
  return { status: response.status, body: response.ok ? await response.json() : null };
}

/** DexScreener first, GeckoTerminal as fallback; null when neither returns this pool. Never throws. */
export async function fetchUniv4MarketData(spec: Univ4AllowlistedPool, options: FetchUniv4MarketOptions = {}): Promise<Univ4MarketData | null> {
  const sources: [Univ4MarketSource, string, (body: unknown, spec: Univ4AllowlistedPool) => Univ4MarketData | null][] = [
    ["dexscreener", dexScreenerPairUrl(spec.poolId), parseDexScreenerPair],
    ["geckoterminal", geckoTerminalPoolUrl(spec.poolId), parseGeckoTerminalPool],
  ];
  for (const [source, url, parse] of sources) {
    if (source === "geckoterminal" && options.allowFallback && !options.allowFallback()) break;
    try {
      const { status, body } = await getJson(url, options);
      if (status === 429) { options.onUpstream?.({ source, outcome: "rate-limited" }); continue; }
      const parsed = status === 200 ? parse(body, spec) : null;
      options.onUpstream?.({ source, outcome: parsed ? "ok" : status === 200 ? "mismatch" : "error" });
      if (parsed) return parsed;
    } catch {
      options.onUpstream?.({ source, outcome: "error" });
    }
  }
  return null;
}

/** UI/API label every displayed APR must carry (PM, 2026-10-29). */
export const ESTIMATED_APR_LABEL = { zh: "估計", en: "Estimated" } as const;

/** Shown next to the APR only when GeckoTerminal data is displayed (their terms); DexScreener needs none (PM, 2026-10-29). */
export const GECKOTERMINAL_ATTRIBUTION = Object.freeze({ text: "Data: GeckoTerminal", url: "https://www.geckoterminal.com" });

export type Univ4PoolApr = {
  /** Always true: an estimate from 24h indexer volume, never a guarantee. */
  estimated: true;
  /** Non-null only when the numbers came from GeckoTerminal (the fallback). */
  attribution: typeof GECKOTERMINAL_ATTRIBUTION | null;
  label: typeof ESTIMATED_APR_LABEL;
  basis: "24h-volume";
  source: Univ4MarketSource;
  /** Hook's current LP fee (mean of both swap directions), percent. The StablePairHook fee is dynamic. */
  feeRatePct: number;
  volume24hUsd: number;
  tvlUsd: number;
  txns24h: number | null;
  /** fee rate × 24h volume / TVL × 365, percent (simple, no compounding). Null when TVL is 0. */
  estimatedPoolFeeAprPct: number | null;
};

/** APR = fee rate × 24h volume / TVL, annualised. */
export function poolAprFromMarket(market: Univ4MarketData, feePips: { zeroForOne: number; oneForZero: number }): Univ4PoolApr {
  const feeRate = (feePips.zeroForOne + feePips.oneForZero) / 2 / 1_000_000;
  return {
    estimated: true, attribution: market.source === "geckoterminal" ? GECKOTERMINAL_ATTRIBUTION : null,
    label: ESTIMATED_APR_LABEL, basis: "24h-volume", source: market.source, feeRatePct: feeRate * 100,
    volume24hUsd: market.volume24hUsd, tvlUsd: market.tvlUsd, txns24h: market.txns24h,
    estimatedPoolFeeAprPct: poolFeeAprPct({ feeRate, dailyVolumeUsd: market.volume24hUsd, tvlUsd: market.tvlUsd }),
  };
}

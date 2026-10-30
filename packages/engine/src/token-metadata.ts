import { JUPITER_SOFT_RETRY, jupiterRequest } from "./jupiter";
import { JUPITER_TOKENS_SEARCH_PATH } from "./jupiter/urls";
import { getJupiterApiKey } from "./config/server-env";

export type TokenMetadata = {
  mint: string;
  name: string;
  symbol: string;
  icon: string | null;
  isVerified: boolean;
  decimals: number;
  tokenProgram: string | null;
};

/**
 * HTTPS hosts a token icon link may point at. Every icon from Jupiter, and every icon the daily refresh stores in the
 * database (Jupiter → Raydium for Solana; DexScreener → GeckoTerminal → manual list for Robinhood Chain), must pass
 * `trustedIcon` first. The last four hosts serve the Raydium, DexScreener and GeckoTerminal (CoinGecko) fallbacks.
 */
export const ICON_HOSTS: ReadonlySet<string> = new Set([
  "static.jup.ag", "raw.githubusercontent.com", "ipfs.io", "upload.wikimedia.org",
  "storage.googleapis.com", "s3-symbol-logo.tradingview.com", "xstocks-metadata.backed.fi",
  "arweave.net", "gateway.pinata.cloud", "backpack.exchange",
  "img-v1.raydium.io", "dd.dexscreener.com", "cdn.dexscreener.com", "coin-images.coingecko.com", "assets.coingecko.com",
]);

function textField(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

/** The icon link if it is HTTPS on an `ICON_HOSTS` host (no credentials or port, at most 1024 chars); otherwise null. */
export function trustedIcon(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 1024) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && ICON_HOSTS.has(url.hostname)
      ? url.toString() : null;
  } catch { return null; }
}

export async function getTokenMetadata(
  mints: string[], fetcher: typeof fetch = fetch, apiKey = getJupiterApiKey(),
): Promise<Record<string, TokenMetadata>> {
  if (!mints.length) return {};
  const requested = new Set(mints);
  try {
    const rows: unknown = await jupiterRequest({
      path: JUPITER_TOKENS_SEARCH_PATH,
      query: { query: mints.join(",") },
      fetcher,
      apiKey,
      cacheKey: `tokens:${mints.join(",")}`,
      cacheTtlMs: 3_600_000,
      retry: JUPITER_SOFT_RETRY,
      signal: AbortSignal.timeout(6_000),
      next: { revalidate: 3600 },
    });
    if (!Array.isArray(rows)) return {};
    const metadata: Record<string, TokenMetadata> = {};
    for (const raw of rows) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const row = raw as Record<string, unknown>;
      if (typeof row.id !== "string" || !requested.has(row.id) ||
        !Number.isInteger(row.decimals) || (row.decimals as number) < 0 || (row.decimals as number) > 255) continue;
      const name = textField(row.name, 80);
      const symbol = textField(row.symbol, 24);
      if (!name || !symbol) continue;
      metadata[row.id] = {
        mint: row.id, name, symbol, icon: trustedIcon(row.icon), isVerified: row.isVerified === true,
        decimals: row.decimals as number, tokenProgram: typeof row.tokenProgram === "string" ? row.tokenProgram : null,
      };
    }
    return metadata;
  } catch { return {}; }
}

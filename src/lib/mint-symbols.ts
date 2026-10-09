import "server-only";

import { ExtensionType, getExtensionData, unpackMint } from "@solana/spl-token";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { getTokenMetadata } from "./token-metadata";

export const RAYDIUM_MINT_IDS = "https://api-v3.raydium.io/mint/ids";
const CACHE_TTL_MS = 60 * 60_000;
const RAYDIUM_BATCH = 50;

type CacheEntry = { expiresAt: number; symbols: Map<string, string> };
let cache: CacheEntry | null = null;

export function clearMintSymbolsCache() {
  cache = null;
}

/** Read a Token-2022 TokenMetadata extension symbol from an already-fetched mint account. */
export function symbolFromMintAccount(mint: PublicKey, info: AccountInfo<Buffer> | null): string | null {
  if (!info) return null;
  try {
    const decoded = unpackMint(mint, info, info.owner);
    const data = getExtensionData(ExtensionType.TokenMetadata, decoded.tlvData);
    if (!data) return null;
    return readToken2022Symbol(data);
  } catch {
    return null;
  }
}

/** Token-2022 TokenMetadata: 32-byte authority + 32-byte mint + Borsh strings. */
function readToken2022Symbol(data: Buffer): string | null {
  if (data.length < 68) return null;
  let offset = 64;
  const nameLen = data.readUInt32LE(offset);
  offset += 4 + nameLen;
  if (nameLen > 80 || offset + 4 > data.length) return null;
  const symbolLen = data.readUInt32LE(offset);
  offset += 4;
  if (symbolLen <= 0 || symbolLen > 24 || offset + symbolLen > data.length) return null;
  const symbol = data.subarray(offset, offset + symbolLen).toString("utf8").replace(/\0/g, "").trim();
  return symbol || null;
}

export type ResolveMintSymbolsOptions = {
  fetcher?: typeof fetch;
  jupiterApiKey?: string | undefined;
  bypassCache?: boolean;
  /** Symbols already known from on-chain Token-2022 metadata. */
  onChain?: Record<string, string | null | undefined>;
};

/**
 * Resolve display symbols for pool/asset mints.
 * Order: cache → on-chain Token-2022 → Raydium mint/ids → Jupiter tokens/v2/search.
 */
export async function resolveMintSymbols(
  mints: string[],
  options: ResolveMintSymbolsOptions = {},
): Promise<Record<string, string>> {
  const unique = [...new Set(mints.filter((mint) => typeof mint === "string" && mint.length > 0))];
  const resolved: Record<string, string> = {};
  if (!unique.length) return resolved;

  const now = Date.now();
  const useCache = !options.bypassCache && cache && cache.expiresAt > now;
  const pending: string[] = [];
  for (const mint of unique) {
    const onChain = options.onChain?.[mint]?.trim();
    if (onChain) {
      resolved[mint] = onChain;
      continue;
    }
    const cached = useCache ? cache!.symbols.get(mint) : undefined;
    if (cached) {
      resolved[mint] = cached;
      continue;
    }
    pending.push(mint);
  }
  if (!pending.length) {
    remember(resolved, now);
    return resolved;
  }

  const fetcher = options.fetcher ?? fetch;
  await fillFromRaydium(pending, resolved, fetcher);
  const stillMissing = pending.filter((mint) => !resolved[mint]);
  if (stillMissing.length) {
    try {
      const jupiter = await getTokenMetadata(
        stillMissing,
        fetcher,
        options.jupiterApiKey ?? process.env.JUPITER_API_KEY,
      );
      for (const mint of stillMissing) {
        const symbol = jupiter[mint]?.symbol?.trim();
        if (symbol) resolved[mint] = symbol;
      }
    } catch {
      /* Jupiter is optional */
    }
  }

  remember(resolved, now);
  return resolved;
}

async function fillFromRaydium(
  mints: string[],
  resolved: Record<string, string>,
  fetcher: typeof fetch,
) {
  for (let index = 0; index < mints.length; index += RAYDIUM_BATCH) {
    const batch = mints.slice(index, index + RAYDIUM_BATCH);
    const url = new URL(RAYDIUM_MINT_IDS);
    url.searchParams.set("mints", batch.join(","));
    try {
      const response = await fetcher(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "SoFinance/0.1 (mint symbols; +https://github.com/truenorth-lj/sofinance-public)",
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) continue;
      const body: unknown = await response.json();
      const rows = Array.isArray(body)
        ? body
        : body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
          ? (body as { data: unknown[] }).data
          : [];
      const requested = new Set(batch);
      for (const raw of rows) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const row = raw as { address?: unknown; symbol?: unknown };
        if (typeof row.address !== "string" || !requested.has(row.address)) continue;
        const symbol = typeof row.symbol === "string" ? row.symbol.trim() : "";
        if (symbol) resolved[row.address] = symbol;
      }
    } catch {
      /* try the next batch / Jupiter */
    }
  }
}

function remember(resolved: Record<string, string>, now: number) {
  const next = cache && cache.expiresAt > now ? new Map(cache.symbols) : new Map<string, string>();
  for (const [mint, symbol] of Object.entries(resolved)) {
    if (symbol) next.set(mint, symbol);
  }
  cache = { expiresAt: now + CACHE_TTL_MS, symbols: next };
}

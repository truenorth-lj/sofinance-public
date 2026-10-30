import "@/lib/engine-host";
import "server-only";
import { getTokenMetadata, trustedIcon } from "@sofinance/engine/token-metadata";
import { DEXSCREENER_CHAIN_ID, GECKOTERMINAL_NETWORK } from "@sofinance/engine/protocols/uniswap-v4/market-data";
import { MANUAL_TOKEN_ICONS, iconAddress, validIconAddress, type IconChain, type IconSource, type TokenIconRow } from "./map";

/** One source: address list in, raw icon value per address out (unvalidated). Must never throw for "not listed". */
export type IconLookup = (addresses: string[], signal?: AbortSignal) => Promise<Record<string, unknown>>;
export type IconSources = { source: IconSource; lookup: IconLookup }[];

const CHUNK = 100;
const TIMEOUT_MS = 6_000;

async function getJson(url: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetcher(url, { headers: { accept: "application/json" }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  return response.ok ? response.json() : null;
}

const chunks = (list: string[]) => Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK));

/** Jupiter token search (the same call `/api/token-metadata` makes), icons already through `trustedIcon`. */
export const jupiterIcons = (fetcher: typeof fetch = fetch): IconLookup => async (mints) => {
  const out: Record<string, unknown> = {};
  for (const part of chunks(mints)) for (const [mint, meta] of Object.entries(await getTokenMetadata(part, fetcher))) out[mint] = meta.icon;
  return out;
};

/** Raydium mint list API (`logoURI`), the fallback the cards already used as a fixed path. */
export const raydiumIcons = (fetcher: typeof fetch = fetch): IconLookup => async (mints, signal) => {
  const out: Record<string, unknown> = {};
  for (const part of chunks(mints)) {
    const body = await getJson(`https://api-v3.raydium.io/mint/ids?mints=${part.join(",")}`, fetcher, signal) as { data?: unknown } | null;
    for (const row of Array.isArray(body?.data) ? body.data : []) {
      if (row && typeof row === "object" && typeof (row as { address?: unknown }).address === "string")
        out[(row as { address: string }).address] = (row as { logoURI?: unknown }).logoURI;
    }
  }
  return out;
};

/** DexScreener token pairs: `info.imageUrl` belongs to the pair's base token. */
export const dexScreenerIcons = (fetcher: typeof fetch = fetch): IconLookup => async (addresses, signal) => {
  const out: Record<string, unknown> = {};
  for (const part of chunks(addresses).map((c) => c.slice(0, 30))) {
    const body = await getJson(`https://api.dexscreener.com/tokens/v1/${DEXSCREENER_CHAIN_ID}/${part.join(",")}`, fetcher, signal);
    for (const pair of Array.isArray(body) ? body : []) {
      const base = (pair as { baseToken?: { address?: unknown } })?.baseToken?.address;
      const image = (pair as { info?: { imageUrl?: unknown } })?.info?.imageUrl;
      if (typeof base === "string" && image && !out[base.toLowerCase()]) out[base.toLowerCase()] = image;
    }
  }
  return out;
};

/** GeckoTerminal token info (`attributes.image_url`; their "missing.png" placeholder counts as none). One call per token. */
export const geckoTerminalIcons = (fetcher: typeof fetch = fetch): IconLookup => async (addresses, signal) => {
  const out: Record<string, unknown> = {};
  for (const address of addresses.slice(0, 10)) {
    const body = await getJson(`https://api.geckoterminal.com/api/v2/networks/${GECKOTERMINAL_NETWORK}/tokens/${address}`, fetcher, signal) as
      { data?: { attributes?: { image_url?: unknown } } } | null;
    const image = body?.data?.attributes?.image_url;
    if (typeof image === "string" && !/missing\.png/i.test(image)) out[address] = image;
  }
  return out;
};

/**
 * First allowlisted icon per token, trying sources in order; a source that fails, lists nothing, or returns a link
 * off `ICON_HOSTS` falls through to the next, and the manual list is last. Every returned `image` has passed
 * `trustedIcon`, so nothing off the allowlist reaches the database.
 */
export async function resolveTokenIcons(chain: IconChain, addresses: readonly string[], sources: IconSources,
  options: { signal?: AbortSignal; manual?: readonly TokenIconRow[]; onIssue?: (message: string) => void } = {}): Promise<TokenIconRow[]> {
  const wanted = [...new Set(addresses.map((address) => iconAddress(chain, address)))].filter((address) => validIconAddress(chain, address));
  const found = new Map<string, TokenIconRow>();
  for (const { source, lookup } of sources) {
    const missing = wanted.filter((address) => !found.has(address));
    if (!missing.length) break;
    options.signal?.throwIfAborted();
    let raw: Record<string, unknown> = {};
    try { raw = await lookup(missing, options.signal); } catch { options.onIssue?.(`Token icons: ${source} unavailable`); }
    for (const address of missing) {
      const image = trustedIcon(raw[address]);
      if (image) found.set(address, { chain, address, image, source });
    }
  }
  for (const row of options.manual ?? MANUAL_TOKEN_ICONS) {
    const address = iconAddress(row.chain, row.address);
    const image = trustedIcon(row.image);
    if (row.chain === chain && image && wanted.includes(address) && !found.has(address)) found.set(address, { ...row, address, image });
  }
  return wanted.flatMap((address) => found.get(address) ?? []);
}

export const solanaIconSources = (fetcher?: typeof fetch): IconSources =>
  [{ source: "jupiter", lookup: jupiterIcons(fetcher) }, { source: "raydium", lookup: raydiumIcons(fetcher) }];
export const rhcIconSources = (fetcher?: typeof fetch): IconSources =>
  [{ source: "dexscreener", lookup: dexScreenerIcons(fetcher) }, { source: "geckoterminal", lookup: geckoTerminalIcons(fetcher) }];

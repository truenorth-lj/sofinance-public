import "@/lib/engine-host";
import "server-only";
import { getTokenMetadata, trustedIcon } from "@sofinance/engine/token-metadata";
import { DEXSCREENER_CHAIN_ID, GECKOTERMINAL_NETWORK } from "@sofinance/engine/protocols/uniswap-v4/market-data";
import type { ThrottleGate } from "@/lib/range-apr/throttle-gate";
import { MANUAL_TOKEN_ICONS, iconAddress, validIconAddress, type IconChain, type IconSource, type TokenIconRow } from "./map";

/** One source: address list in, raw icon value per address out (unvalidated). Must never throw for "not listed". */
export type IconLookup = (addresses: string[], signal?: AbortSignal) => Promise<Record<string, unknown>>;
export type IconSources = { source: IconSource; lookup: IconLookup }[];

const CHUNK = 100;
const TIMEOUT_MS = 6_000;

async function getJson(url: string, fetcher: typeof fetch, signal?: AbortSignal, gate?: ThrottleGate): Promise<unknown> {
  const call = async () => {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetcher(url, { headers: { accept: "application/json" }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (response.status === 429) gate?.block();
    return response.ok ? response.json() : null;
  };
  if (!gate) return call();
  // Through the cron run's GeckoTerminal gate: spaced with every other call, refused after a 429.
  const run = await gate.run(call);
  return "value" in run ? run.value : null;
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

/**
 * GeckoTerminal token info, batched: `/tokens/multi/{a,b,…}` (up to 30 per call; keyless GeckoTerminal allows only a
 * few calls a minute, so one call covers every allowlisted Robinhood Chain token). `attributes.image_url`; their
 * "missing.png" placeholder counts as none.
 */
export const GECKOTERMINAL_TOKENS_PER_CALL = 30;
export const geckoTerminalIcons = (fetcher: typeof fetch = fetch, gate?: ThrottleGate): IconLookup => async (addresses, signal) => {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < addresses.length; i += GECKOTERMINAL_TOKENS_PER_CALL) {
    const part = addresses.slice(i, i + GECKOTERMINAL_TOKENS_PER_CALL);
    const body = await getJson(`https://api.geckoterminal.com/api/v2/networks/${GECKOTERMINAL_NETWORK}/tokens/multi/${part.join(",")}`, fetcher, signal, gate) as
      { data?: unknown } | null;
    for (const token of Array.isArray(body?.data) ? body.data : []) {
      const attributes = (token as { attributes?: { address?: unknown; image_url?: unknown } } | null)?.attributes;
      const address = typeof attributes?.address === "string" ? attributes.address.toLowerCase() : null;
      const image = attributes?.image_url;
      if (address && part.includes(address) && typeof image === "string" && !/missing\.png/i.test(image)) out[address] = image;
    }
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
/**
 * The cron icon pass for Robinhood Chain tokens: DexScreener only. The run's GeckoTerminal budget (~5 calls/min per
 * shared IP, see `CRON_GECKO_SPACING_MS`) goes to the APR price histories. Tokens DexScreener does not list return no
 * row, so the icons already saved for them (21 of 22 from GeckoTerminal, 10/31) are left as they are.
 */
export const rhcCronIconSources = (fetcher?: typeof fetch): IconSources =>
  [{ source: "dexscreener", lookup: dexScreenerIcons(fetcher) }];
/** `gate`: a GeckoTerminal gate, so the call is spaced and stops after a 429. Not used by the cron (see above). */
export const rhcIconSources = (fetcher?: typeof fetch, gate?: ThrottleGate): IconSources =>
  [{ source: "dexscreener", lookup: dexScreenerIcons(fetcher) }, { source: "geckoterminal", lookup: geckoTerminalIcons(fetcher, gate) }];

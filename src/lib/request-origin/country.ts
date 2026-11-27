import { processHeaderEnv, trustedEdges, type HeaderEnv, type TrustedEdges } from "./trust";

/**
 * The visitor's country from the hosting edge, as an ordered list of providers. The first trusted provider with a
 * usable value wins; when none has one the result is `null` ("unknown"), and callers keep their no-header behavior.
 *
 * Order: Cloudflare `CF-IPCountry`, then Vercel `x-vercel-ip-country`. See `trust.ts` for when each is believed.
 * Values are trimmed and upper-cased, exactly as callers did before; an empty value counts as missing. Cloudflare's
 * `XX` ("no country data") also counts as missing so a later provider can still answer.
 */
export type GeoProviderId = "cloudflare" | "vercel";

export interface GeoProvider {
  readonly id: GeoProviderId;
  readonly header: string;
  readonly trusted: (edges: TrustedEdges) => boolean;
  /** Raw codes this provider sends to mean "unknown". */
  readonly unknownCodes: readonly string[];
}

export const GEO_PROVIDERS: readonly GeoProvider[] = [
  { id: "cloudflare", header: "cf-ipcountry", trusted: (edges) => edges.cloudflare, unknownCodes: ["XX"] },
  { id: "vercel", header: "x-vercel-ip-country", trusted: (edges) => edges.vercel, unknownCodes: [] },
];

export interface RequestCountry {
  /** Upper-cased country code as sent by the edge (normally ISO 3166-1 alpha-2). */
  readonly country: string;
  readonly provider: GeoProviderId;
}

export function requestCountry(headers: Headers, env: HeaderEnv = processHeaderEnv()): RequestCountry | null {
  const edges = trustedEdges(env);
  for (const provider of GEO_PROVIDERS) {
    if (!provider.trusted(edges)) continue;
    const country = headers.get(provider.header)?.trim().toUpperCase();
    if (!country || provider.unknownCodes.includes(country)) continue;
    return { country, provider: provider.id };
  }
  return null;
}

/**
 * Restricted regions (single source of truth for the web app, the remote MCP endpoint and the
 * blocked page). Keep this list identical to the Terms of Service.
 *
 * Detection uses the IP geolocation headers Vercel adds to every request:
 * - `x-vercel-ip-country`: ISO 3166-1 alpha-2 country code (e.g. "TW").
 * - `x-vercel-ip-country-region`: the region portion of the ISO 3166-2 code (e.g. "43" for UA-43).
 * Clients cannot spoof these on Vercel: the platform overwrites them on ingress.
 */

export const RESTRICTED_COUNTRIES: Readonly<Record<string, string>> = {
  TW: "Taiwan",
  US: "United States",
  PR: "Puerto Rico",
  GU: "Guam",
  VI: "U.S. Virgin Islands",
  AS: "American Samoa",
  MP: "Northern Mariana Islands",
  UM: "U.S. Minor Outlying Islands",
  CU: "Cuba",
  IR: "Iran",
  KP: "North Korea",
  SY: "Syria",
};

/** First-level subdivisions blocked inside an otherwise allowed country (ISO 3166-2). */
export const RESTRICTED_SUBDIVISIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  UA: {
    "43": "Crimea",
    "40": "Sevastopol",
    "14": "Donetsk",
    "09": "Luhansk",
  },
};

/** Human-readable list for UI and docs (same order as the Terms of Service). */
export const RESTRICTED_REGION_LABELS = [
  "Taiwan",
  "the United States and its territories (Puerto Rico, Guam, the U.S. Virgin Islands, American Samoa, the Northern Mariana Islands and the U.S. Minor Outlying Islands)",
  "Cuba",
  "Iran",
  "North Korea",
  "Syria",
  "the Crimea, Sevastopol, Donetsk and Luhansk regions of Ukraine",
] as const;

export const RESTRICTED_REGIONS_SENTENCE =
  "SoFinance is not available to residents of, or people located in, Taiwan, the United States (including its territories), Cuba, Iran, North Korea, Syria, or the Crimea, Sevastopol, Donetsk and Luhansk regions of Ukraine.";

export type GeoLocation = { country: string | null; region: string | null };

export type RegionDecision =
  | { blocked: false; country: string | null }
  | { blocked: true; country: string; region: string | null; label: string };

const normalize = (value: string | null | undefined) => {
  const trimmed = value?.trim().toUpperCase();
  return trimmed ? trimmed : null;
};

/**
 * Normalize a subdivision code. Accepts "43", "UA-43" or "ua-43"; numeric codes are zero-padded
 * to two digits so "9" and "09" both match Luhansk.
 */
export function normalizeSubdivision(country: string, region: string | null | undefined): string | null {
  let value = normalize(region);
  if (!value) return null;
  if (value.startsWith(`${country}-`)) value = value.slice(country.length + 1);
  if (/^\d$/.test(value)) value = `0${value}`;
  return value;
}

export function evaluateRegion(geo: GeoLocation): RegionDecision {
  const country = normalize(geo.country);
  if (!country) return { blocked: false, country: null };
  const countryLabel = RESTRICTED_COUNTRIES[country];
  if (countryLabel) return { blocked: true, country, region: null, label: countryLabel };
  const subdivisions = RESTRICTED_SUBDIVISIONS[country];
  const region = normalizeSubdivision(country, geo.region);
  if (subdivisions && region && subdivisions[region]) {
    return { blocked: true, country, region, label: subdivisions[region] };
  }
  return { blocked: false, country };
}

/** Header / cookie / query names for the non-production test override. */
export const GEO_OVERRIDE_HEADER = "x-sofinance-geo-override";
export const GEO_OVERRIDE_COOKIE = "sofinance_geo_override";
export const GEO_OVERRIDE_QUERY = "__geo";

type Env = Record<string, string | undefined>;

/**
 * The geo override exists so the blocked and allowed flows can be tested from anywhere (the owner is
 * in Taiwan). It is NEVER honoured on a Vercel production deployment, and outside Vercel only under
 * `next dev` / tests. Preview deployments sit behind Vercel deployment protection.
 */
const deploymentEnv = (): Env => ({ VERCEL: process.env.VERCEL, VERCEL_ENV: process.env.VERCEL_ENV, NODE_ENV: process.env.NODE_ENV });

export function geoOverrideAllowed(env: Env = deploymentEnv()): boolean {
  if (env.VERCEL_ENV === "production") return false;
  if (env.VERCEL_ENV === "preview" || env.VERCEL_ENV === "development") return true;
  if (env.VERCEL) return false;
  return env.NODE_ENV !== "production";
}

/** Parse "TW", "UA-43" or "UA:43" into a location; anything else is ignored. */
export function parseGeoOverride(value: string | null | undefined): GeoLocation | null {
  const match = value?.trim().toUpperCase().match(/^([A-Z]{2})(?:[-:]([A-Z0-9]{1,3}))?$/);
  if (!match) return null;
  return { country: match[1]!, region: match[2] ?? null };
}

type HeaderSource = { get(name: string): string | null };
type CookieSource = { get(name: string): { value: string } | undefined };

export function readGeo(
  headers: HeaderSource,
  options: { cookies?: CookieSource; query?: URLSearchParams; env?: Env } = {},
): GeoLocation & { overridden: boolean } {
  if (geoOverrideAllowed(options.env)) {
    const override = parseGeoOverride(options.query?.get(GEO_OVERRIDE_QUERY))
      ?? parseGeoOverride(headers.get(GEO_OVERRIDE_HEADER))
      ?? parseGeoOverride(options.cookies?.get(GEO_OVERRIDE_COOKIE)?.value);
    if (override) return { ...override, overridden: true };
  }
  return {
    country: headers.get("x-vercel-ip-country"),
    region: headers.get("x-vercel-ip-country-region"),
    overridden: false,
  };
}

export const REGION_RESTRICTED_CODE = "region_restricted";
export const REGION_RESTRICTED_MESSAGE =
  "SoFinance is not available in your region. Opening, adding to and compounding positions is disabled. Withdrawals stay available.";

export function regionRestrictedBody(decision: Extract<RegionDecision, { blocked: true }>) {
  return {
    error: REGION_RESTRICTED_MESSAGE,
    code: REGION_RESTRICTED_CODE,
    country: decision.country,
    ...(decision.region ? { region: decision.region } : {}),
    withdraw: "/app/exit",
    terms: "/terms",
  };
}

/** Appended to transaction-building MCP tool descriptions (HTTP and stdio servers). */
export const MCP_RESTRICTED_REGIONS_NOTE =
  " Restricted regions: not available to residents of, or people located in, the United States (incl. territories), Taiwan, Cuba, Iran, North Korea, Syria, or Ukraine's Crimea, Sevastopol, Donetsk and Luhansk regions; the hosted endpoint refuses these calls from those regions (HTTP 403, code region_restricted). Withdrawal tools stay available everywhere. See /terms.";

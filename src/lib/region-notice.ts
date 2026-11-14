import { APP_ROUTES } from "@/lib/public-urls";

/**
 * Region-availability notice for visitors from countries xStocks does not serve.
 *
 * Notice only: no IP block, no redirect, no 403/451, and no disabled connect / open / withdraw.
 * The country comes from Vercel's free `x-vercel-ip-country` header (ISO 3166-1 alpha-2), read in
 * `src/proxy.ts`. The Proxy sets:
 * - a short-lived flag cookie (`sf_region_notice`) for visitors in the country list
 * - a request header (`x-sofi-region-notice: 1`) when the notice should appear on this path, so
 *   the server component can put the banner in the initial HTML (no post-hydration layout shift)
 * Missing or unknown country → no banner. Shown only on `/app` and `/app/rwa-pairs`.
 * Dismissal is a cookie the server reads, so a dismissed banner stays out of the HTML.
 *
 * Country list (ISO 3166-1 alpha-2), fetched 2026-11-10 (Asia/Taipei):
 * - https://xstocks.com/documents/xstocks-terms-of-service.pdf §1.3
 *   Clearly listed: United States / U.S. Persons (US).
 * - https://docs.xstocks.fi/docs/product-legal-overview (Distribution Restrictions)
 *   Clearly listed: United States / U.S. Persons (US). Also says "or in any other prohibited
 *   jurisdiction" without enumerating those jurisdictions.
 * - Distributor public list (not issuer terms, used only where it names countries clearly):
 *   https://support.kraken.com/articles/xstocks-availability (updated 2026-06-18)
 *   and https://support.kraken.com/articles/xstocks-faq (updated 2026-10-30):
 *   United States, Canada, UK, Australia. UK is encoded as GB.
 *
 * Ambiguity: "prohibited jurisdiction", "prohibited regions", and "sanctioned jurisdictions" are
 * not enumerated by xStocks or Backed, so they are not added here.
 *
 * This is the only country list in the app. Sanctions wording lives in the Terms (Section 3) and
 * is not enforced by IP; see src/lib/terms-content.ts.
 */
export const REGION_NOTICE_COUNTRIES = ["US", "CA", "GB", "AU"] as const;

/** Official xStocks distribution-restrictions page linked from the notice. */
export const XSTOCKS_ELIGIBILITY_TERMS_URL = "https://docs.xstocks.fi/docs/product-legal-overview";

export const REGION_NOTICE_TEXT =
  "xStocks tokens may not be available in your region. Check xStocks' eligibility terms before trading.";

export const REGION_NOTICE_LINK_TEXT = "xStocks' eligibility terms";

/** Pages that may show the notice. Other routes never render it. */
export const REGION_NOTICE_PATHS = [APP_ROUTES.home, APP_ROUTES.rwaPairs] as const;

/** Readable flag cookie set by the Proxy for visitors in `REGION_NOTICE_COUNTRIES`. Holds no country code. */
export const REGION_NOTICE_COOKIE = "sf_region_notice";
export const REGION_NOTICE_COOKIE_MAX_AGE = 60 * 60 * 24;

/** Set by the client when the visitor dismisses the notice; the server reads it so HTML omits the banner. */
export const REGION_NOTICE_DISMISS_COOKIE = "sf_region_notice_dismissed";
export const REGION_NOTICE_DISMISS_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Request header the Proxy sets to `1` when this response should include the banner.
 * Read by the server component; not a security control (the notice never blocks).
 */
export const REGION_NOTICE_REQUEST_HEADER = "x-sofi-region-notice";

/** Local-build / screenshot override. Ignored when VERCEL_ENV is production. */
export const REGION_NOTICE_FORCE_PARAM = "forceRegionNotice";
export const REGION_NOTICE_FORCE_COUNTRY_PARAM = "forceCountry";

const countries: ReadonlySet<string> = new Set(REGION_NOTICE_COUNTRIES);

/** `true` = show, `false` = known country outside the list, `null` = unknown (no header). */
export function regionNoticeForCountry(country: string | null | undefined): boolean | null {
  const code = country?.trim().toUpperCase();
  if (!code) return null;
  return countries.has(code);
}

export function isRegionNoticePath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const path = pathname.replace(/\/+$/, "") || "/";
  return (REGION_NOTICE_PATHS as readonly string[]).includes(path);
}

type SearchParams = { get(name: string): string | null };

/**
 * Country used for the notice: Vercel geo header, or a non-production query override
 * (`?forceCountry=US` or `?forceRegionNotice=1`, which simulates US).
 */
export function resolveNoticeCountry(
  header: string | null | undefined,
  searchParams?: SearchParams | null,
  vercelEnv?: string | null,
): string | null | undefined {
  if (vercelEnv !== "production" && searchParams) {
    const forced = searchParams.get(REGION_NOTICE_FORCE_COUNTRY_PARAM)?.trim();
    if (forced) return forced;
    if (searchParams.get(REGION_NOTICE_FORCE_PARAM) === "1") return "US";
  }
  return header;
}

export function shouldShowRegionNotice(input: {
  countryHeader?: string | null;
  pathname?: string | null;
  searchParams?: SearchParams | null;
  vercelEnv?: string | null;
  dismissed?: boolean;
}): boolean {
  if (input.dismissed) return false;
  if (!isRegionNoticePath(input.pathname)) return false;
  return regionNoticeForCountry(resolveNoticeCountry(input.countryHeader, input.searchParams, input.vercelEnv)) === true;
}

export function hasRegionNoticeCookie(cookieHeader: string): boolean {
  return cookieHeader.split(";").some((part) => part.trim() === `${REGION_NOTICE_COOKIE}=1`);
}

export function hasRegionNoticeDismissCookie(cookieHeader: string): boolean {
  return cookieHeader.split(";").some((part) => part.trim() === `${REGION_NOTICE_DISMISS_COOKIE}=1`);
}

export function regionNoticeDismissSetCookie(secure: boolean): string {
  return `${REGION_NOTICE_DISMISS_COOKIE}=1; Path=/; Max-Age=${REGION_NOTICE_DISMISS_MAX_AGE}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

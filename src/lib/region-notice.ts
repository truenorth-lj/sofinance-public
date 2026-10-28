/**
 * Region notice (LJ decision, 2026-10-28): visitors from these countries see a small, dismissible
 * notice. They are NOT blocked: no redirect, no 403/451, no disabled connect / open / withdraw.
 *
 * The country comes from Vercel's `x-vercel-ip-country` header, read in `src/proxy.ts`, which sets a
 * short-lived flag cookie so pages stay static and CDN-cached. `<RegionNotice />` reads that cookie.
 * Without the header (local dev, non-Vercel hosts) nothing is shown.
 *
 * This is the only country list in the app. Sanctions wording lives in the Terms (Section 3) and is
 * not enforced by IP; see src/lib/terms-content.ts.
 */
export const REGION_NOTICE_COUNTRIES = ["US", "CA", "GB", "AU"] as const;

export const REGION_NOTICE_TEXT =
  "SoFinance is a self-custody interface to on-chain protocols. Tokenized stocks and DeFi may be restricted or treated differently where you live — please check what applies to you before using the app.";

/** Readable flag cookie set by the Proxy for visitors in `REGION_NOTICE_COUNTRIES`. Holds no country code. */
export const REGION_NOTICE_COOKIE = "sf_region_notice";
export const REGION_NOTICE_COOKIE_MAX_AGE = 60 * 60 * 24;
/** localStorage key for "dismissed in this browser". */
export const REGION_NOTICE_DISMISS_KEY = "sofinance:region-notice-dismissed";

const countries: ReadonlySet<string> = new Set(REGION_NOTICE_COUNTRIES);

/** `true` = show, `false` = known country outside the list, `null` = unknown (no header). */
export function regionNoticeForCountry(country: string | null | undefined): boolean | null {
  const code = country?.trim().toUpperCase();
  if (!code) return null;
  return countries.has(code);
}

export function hasRegionNoticeCookie(cookieHeader: string): boolean {
  return cookieHeader.split(";").some((part) => part.trim() === `${REGION_NOTICE_COOKIE}=1`);
}

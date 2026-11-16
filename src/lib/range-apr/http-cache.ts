const CDN_HEADERS = Object.freeze({
  "Cache-Control": "public, max-age=0, must-revalidate",
  "CDN-Cache-Control": "public, s-maxage=30, stale-while-revalidate=300",
});

/** Missing estimates use a short lifetime with no stale window, so a degraded answer cannot linger for minutes. */
const DEGRADED_CDN_HEADERS = Object.freeze({
  "Cache-Control": "public, max-age=0, must-revalidate",
  "CDN-Cache-Control": "public, s-maxage=10",
});

/** Success responses only; admission failures and upstream errors retain their route's no-store policy. */
export function rangeAprCdnHeaders(degraded: boolean) {
  return degraded ? DEGRADED_CDN_HEADERS : CDN_HEADERS;
}

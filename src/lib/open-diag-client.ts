// THROWAWAY DIAGNOSTIC (diag/phantom-sol-bisect) — DO NOT MERGE.
// Reads `?diag=<variant>` from the page URL; never on production.
export function clientOpenDiag(): string | undefined {
  if (typeof window === "undefined") return undefined;
  if (process.env.NEXT_PUBLIC_VERCEL_ENV === "production") return undefined;
  if (/(^|\.)sofinancelab\.xyz$/.test(window.location.hostname)) return undefined;
  const value = new URLSearchParams(window.location.search).get("diag");
  return value && /^(v0|v1|v2|v3|v3b|v4|s1)$/.test(value) ? value : undefined;
}

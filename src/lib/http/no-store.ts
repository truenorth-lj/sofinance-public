/** Response headers for API answers that must never be cached (per-wallet, per-request or error responses). */
export const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

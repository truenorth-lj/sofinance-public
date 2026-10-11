/**
 * Portal keys (`JUPITER_API_KEY`) authenticate against `api.jup.ag` via
 * `x-api-key`. `lite-api.jup.ag` is being retired; keyless traffic also uses
 * `api.jup.ag` (0.5 RPS). Never log the key.
 */
export const JUPITER_API_HOST = "api.jup.ag";
export const JUPITER_API_ORIGIN = `https://${JUPITER_API_HOST}`;
export const JUPITER_LITE_HOST = "lite-api.jup.ag";

export const JUPITER_QUOTE_PATH = "/swap/v1/quote";
export const JUPITER_SWAP_INSTRUCTIONS_PATH = "/swap/v1/swap-instructions";
export const JUPITER_BUILD_PATH = "/swap/v2/build";
export const JUPITER_PRICE_V3_PATH = "/price/v3";
export const JUPITER_TOKENS_SEARCH_PATH = "/tokens/v2/search";

export const JUPITER_PRICE_V3 = `${JUPITER_API_ORIGIN}${JUPITER_PRICE_V3_PATH}`;
export const JUPITER_TOKENS_SEARCH = `${JUPITER_API_ORIGIN}${JUPITER_TOKENS_SEARCH_PATH}`;

export function jupiterBaseUrl(): string {
  return JUPITER_API_ORIGIN;
}

export function jupiterUrl(path: string, query?: Record<string, string | number | boolean | undefined>): URL {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, jupiterBaseUrl());
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

export function resolveJupiterApiKey(explicit?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.E2E_KEYLESS_JUPITER === "1") return undefined;
  const key = explicit ?? env.JUPITER_API_KEY;
  return key ? key : undefined;
}

export function jupiterHeaders(apiKey?: string, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json", ...extra };
  const key = resolveJupiterApiKey(apiKey);
  if (key) headers["x-api-key"] = key;
  return headers;
}

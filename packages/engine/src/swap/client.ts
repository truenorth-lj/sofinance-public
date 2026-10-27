import { jupiterRequest, JUPITER_PREVIEW_QUOTE_TTL_MS, JUPITER_QUOTE_TTL_MS, type JupiterQuoteParams, type JupiterRequestOptions } from "../jupiter/client";
import { quoteCacheKey } from "../jupiter/cache";
import { JupiterHttpError } from "../jupiter/errors";
import { directRouteConstraints } from "../jupiter-route-retry";

export async function jupiterQuote<T = Record<string, unknown>>(params: JupiterQuoteParams & { platformFeeBps?: number; previewCache?: boolean }): Promise<T> {
  const slippageBps = params.slippageBps ?? 50;
  const query = {
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    slippageBps,
    instructionVersion: "V2",
    ...(params.platformFeeBps ? { platformFeeBps: params.platformFeeBps } : {}),
    ...(params.dexes ? { dexes: params.dexes } : {}),
    ...(params.excludeDexes ? { excludeDexes: params.excludeDexes } : {}),
    ...(params.maxAccounts !== undefined ? { maxAccounts: params.maxAccounts } : {}),
    ...(params.onlyDirectRoutes ? { onlyDirectRoutes: true } : {}),
  };
  return jupiterRequest<T>({
    path: "/swap/v1/quote",
    query,
    signal: params.signal,
    fetcher: params.fetcher,
    apiKey: params.apiKey,
    budget: params.budget,
    // Preview quotes key on every query field (fees, dex filters included) and live briefly.
    cacheKey: params.previewCache ? `preview-quote:${JSON.stringify(query)}` : params.cacheKey === null || params.dexes || params.excludeDexes || params.platformFeeBps ? null : quoteCacheKey({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      slippageBps,
      maxAccounts: params.maxAccounts,
      onlyDirectRoutes: params.onlyDirectRoutes,
    }),
    cacheTtlMs: params.previewCache ? JUPITER_PREVIEW_QUOTE_TTL_MS : JUPITER_QUOTE_TTL_MS,
  });
}

export async function jupiterQuotePreferCompact<T = Record<string, unknown>>(
  params: Omit<JupiterQuoteParams, "maxAccounts" | "onlyDirectRoutes"> & { maxAccounts?: number; platformFeeBps?: number },
): Promise<T> {
  try {
    return await jupiterQuote<T>({ ...params, maxAccounts: params.maxAccounts ?? 16, onlyDirectRoutes: true });
  } catch (error) {
    if (!(error instanceof JupiterHttpError) || error.status !== 400) throw error;
    return jupiterQuote<T>({ ...params, ...directRouteConstraints() });
  }
}

export async function jupiterSwapInstructions<T = Record<string, unknown>>(
  body: unknown,
  options: Pick<JupiterRequestOptions, "signal" | "fetcher" | "apiKey" | "budget"> = {},
): Promise<T> {
  return jupiterRequest<T>({
    path: "/swap/v1/swap-instructions",
    method: "POST",
    body,
    signal: options.signal,
    fetcher: options.fetcher,
    apiKey: options.apiKey,
    budget: options.budget,
    cacheKey: null,
    cacheTtlMs: null,
  });
}


import { resetJupiterCache, setJupiterCache } from "./cache";
import { setJupiterLogger } from "./logger";
import { resetJupiterRateGate, setJupiterRetryConfig } from "./client";

export {
  JUPITER_API_HOST,
  JUPITER_API_ORIGIN,
  JUPITER_LITE_HOST,
  JUPITER_QUOTE_PATH,
  JUPITER_SWAP_INSTRUCTIONS_PATH,
  JUPITER_PRICE_V3_PATH,
  JUPITER_TOKENS_SEARCH_PATH,
  JUPITER_PRICE_V3,
  JUPITER_TOKENS_SEARCH,
  jupiterBaseUrl,
  jupiterUrl,
  jupiterHeaders,
  resolveJupiterApiKey,
} from "./urls";

export {
  JUPITER_UNAVAILABLE_MESSAGE,
  JUPITER_UNAVAILABLE_CODE,
  JUPITER_NO_ROUTE_CODE,
  RPC_UNAVAILABLE_CODE,
  JupiterHttpError,
  JupiterUnavailableError,
  classifyJupiterError,
  isJupiterUpstreamError,
  isJupiterNoRouteHttp,
  looksLikeJupiterUpstream,
  asJupiterUserError,
  retryAfterFromJupiterHeaders,
} from "./errors";

export {
  JUPITER_RETRY,
  JUPITER_FETCH_TIMEOUT_MS,
  JUPITER_SOFT_RETRY,
  JUPITER_QUOTE_TTL_MS,
  JUPITER_PRICE_TTL_MS,
  SELECTED_RATE_LIMIT_RETRY_MS,
  EXIT_JUPITER_CONCURRENCY,
  setJupiterRetryConfig,
  resetJupiterRateGate,
  noteJupiterRateHeaders,
  jupiterRateGateWaitMs,
  JUPITER_PREVIEW_QUOTE_TTL_MS,
  jupiterRetryConfig,
  jupiterRequest,
  jupiterQuote,
  jupiterQuotePreferCompact,
  jupiterSwapInstructions,
  mapPool,
} from "./client";
export type { JupiterRequestOptions, JupiterQuoteParams } from "./client";

export { quoteCacheKey, resetJupiterCache, setJupiterCache, withJupiterCache } from "./cache";
export {
  jupiterLogEnabled,
  formatJupiterLog,
  setJupiterLogger,
  emitJupiterLog,
  logExitPreviewFailure,
} from "./logger";

export function resetJupiterRuntime(): void {
  resetJupiterCache();
  setJupiterCache(null);
  setJupiterLogger(null);
  setJupiterRetryConfig(null);
  resetJupiterRateGate();
}

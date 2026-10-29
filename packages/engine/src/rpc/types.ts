/** Metric / history label. Dedicated RPCs (Helius, etc.) report as `default`. */
export type RpcMetricId = "default";

/** Config catalog id. `generic` is SOLANA_RPC_URL (Helius or any JSON-RPC). */
export type RpcProviderId = "generic" | "public";

/** @deprecated Use RpcMetricId. Kept so existing history/UI labels stay stable. */
export type RpcProvider = RpcMetricId;

export type RpcEnv = Record<string, string | undefined>;

export type RpcErrorKind =
  | "validation"
  | "auth"
  | "http-4xx"
  | "http-5xx"
  | "rate-limit"
  | "timeout"
  | "empty"
  | "other";

/**
 * Why a call was not served by the first provider in its route.
 * `local-rate-limit`: the provider's own requests-per-second budget was spent, so the call overflowed to
 * the next provider before ever sending a request (no error happened).
 */
/**
 * Why a call left its first provider, or (`min-context-slot`, on retry lines) why it waited: a read
 * provider was behind the request's `minContextSlot`.
 */
export type RpcFallbackReason = "circuit-open" | "primary-error" | "local-rate-limit" | "min-context-slot";

/**
 * Which providers may serve a method.
 * - `transaction`: send / simulate / blockhash / confirm. Only providers allowed for transactions, in
 *   their configured order (with no SOLANA_RPC_PROVIDERS: today's primary → fallback pair).
 * - `context`: slot-context reads whose slot feeds a later simulation (`minContextSlot`). They follow
 *   the transaction providers, except on a read-only connection (`rpcReadConnection`).
 * - `read`: everything else. Spread across the read providers, sticky per connection.
 */
export type RpcRoute = "transaction" | "context" | "read";

export type MethodPolicy = {
  /**
   * When true, listed `fallbackOn` kinds may run on the next provider.
   * Send/confirm re-broadcast the same signed payload (idempotent by signature).
   */
  fallback: boolean;
  fallbackOn: readonly RpcErrorKind[];
  /** Treat this successful return value as empty and apply empty-fallback. */
  emptyWhen?: (value: unknown) => boolean;
  /** Provider route; defaults to `read`. */
  route?: RpcRoute;
};

export type RpcCallMetric = {
  method: string;
  servedBy: RpcMetricId;
  fallback: boolean;
  errorKind?: RpcErrorKind;
  retries?: number;
  cacheHit?: boolean;
  /** Pool provider name (SOLANA_RPC_PROVIDERS only). */
  via?: string;
};

export type ResolvedProvider = {
  id: RpcProviderId;
  metricId: RpcMetricId;
  label: string;
  endpoint: string;
};

export type ProviderPair = {
  primary: ResolvedProvider;
  fallback: ResolvedProvider | null;
};

export type RpcConfig = {
  endpoint: string;
  provider: RpcMetricId;
};

export type RpcLogEvent = {
  method: string;
  provider: RpcMetricId;
  outcome: "ok" | "retry" | "fallback" | "cache-hit" | "error";
  attempt?: number;
  retries?: number;
  cacheHit?: boolean;
  errorKind?: RpcErrorKind;
  reason?: RpcFallbackReason;
  /** Pool provider name (from SOLANA_RPC_PROVIDERS). Key- and URL-free. Absent in the legacy setup. */
  via?: string;
};

export type RpcLogger = (event: RpcLogEvent) => void;

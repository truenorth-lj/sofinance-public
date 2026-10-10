/** Metric / history label. Dedicated RPCs (Helius, etc.) report as `default`. */
export type RpcMetricId = "solami" | "default";

/** Config catalog id. `generic` is SOLANA_RPC_URL (Helius or any JSON-RPC). */
export type RpcProviderId = "solami" | "generic" | "public";

/** @deprecated Use RpcMetricId. Kept so existing history/UI labels stay stable. */
export type RpcProvider = RpcMetricId;

export type RpcEnv = Record<string, string | undefined>;

export type RpcErrorKind =
  | "validation"
  | "http-4xx"
  | "http-5xx"
  | "empty"
  | "other";

export type MethodPolicy = {
  /** Sends must never be retried on another endpoint. */
  fallback: boolean;
  fallbackOn: readonly RpcErrorKind[];
  /** Treat this successful return value as empty and apply empty-fallback. */
  emptyWhen?: (value: unknown) => boolean;
};

export type RpcCallMetric = {
  method: string;
  servedBy: RpcMetricId;
  fallback: boolean;
  errorKind?: RpcErrorKind;
};

export type ResolvedProvider = {
  id: RpcProviderId;
  metricId: RpcMetricId;
  label: string;
  endpoint: string;
  customMethods: readonly string[];
};

export type ProviderPair = {
  primary: ResolvedProvider;
  fallback: ResolvedProvider | null;
};

export type RpcConfig = {
  endpoint: string;
  provider: RpcMetricId;
};

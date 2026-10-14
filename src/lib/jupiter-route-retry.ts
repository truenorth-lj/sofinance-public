export type JupiterRouteConstraints = {
  maxAccounts: number;
  dexes?: string;
  onlyDirectRoutes?: boolean;
};

/** Jupiter `maxAccounts` budgets shared by every swap path (single source of truth). */
export const JUPITER_MAX_ACCOUNTS = {
  wide: 48,
  medium: 32,
  compact: 24,
  direct: 20,
  /** Fee-only conversion routes appended to an existing packet. */
  feeRoute: 16,
} as const;

/** Fresh direct-route constraints (callers may mutate their copy). */
export const directRouteConstraints = (): JupiterRouteConstraints =>
  ({ maxAccounts: JUPITER_MAX_ACCOUNTS.direct, onlyDirectRoutes: true });

/** Tightening Jupiter /build constraints when the assembled v0 tx exceeds 1,232 bytes. */
export const JUPITER_ROUTE_ATTEMPTS: readonly JupiterRouteConstraints[] = [
  { maxAccounts: JUPITER_MAX_ACCOUNTS.wide },
  { maxAccounts: JUPITER_MAX_ACCOUNTS.medium },
  { maxAccounts: JUPITER_MAX_ACCOUNTS.compact },
  directRouteConstraints(),
];

export function isTxOversizeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /1,?232 byte/i.test(message) || /encoding overruns Uint8Array/i.test(message);
}

export async function withJupiterRouteRetries<T>(
  fn: (constraints: JupiterRouteConstraints) => Promise<T>,
): Promise<T> {
  let last: unknown;
  for (const attempt of JUPITER_ROUTE_ATTEMPTS) {
    try {
      return await fn(attempt);
    } catch (error) {
      last = error;
      if (!isTxOversizeError(error)) throw error;
    }
  }
  throw last;
}

export type JupiterRouteConstraints = {
  maxAccounts: number;
  onlyDirectRoutes?: boolean;
};

/** Tightening Jupiter /build constraints when the assembled v0 tx exceeds 1,232 bytes. */
export const JUPITER_ROUTE_ATTEMPTS: readonly JupiterRouteConstraints[] = [
  { maxAccounts: 48 },
  { maxAccounts: 32 },
  { maxAccounts: 24 },
  { maxAccounts: 20, onlyDirectRoutes: true },
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

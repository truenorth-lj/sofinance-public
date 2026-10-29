/** Public Solana mainnet RPC used only when no dedicated endpoint is configured. */
export const PUBLIC_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";

/**
 * Hosts of retired RPC vendors. An endpoint on one of these hosts (or a subdomain), whether from
 * SOLANA_RPC_URL or a SOLANA_RPC_PROVIDERS entry (literal or `$VAR`), is skipped exactly like an
 * unset `$VAR`, so a stale env entry can never route traffic there. Delete an entry once no
 * deployment's env references that host any more.
 */
export const RETIRED_RPC_HOSTS: readonly string[] = ["solami.dev"];

/** True for an endpoint on a retired RPC host. Never throws. */
export function isRetiredRpcEndpoint(endpoint: string): boolean {
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase();
    return RETIRED_RPC_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

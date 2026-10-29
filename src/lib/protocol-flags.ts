/**
 * Code-level flags for protocols that are not yet generally available. Like
 * `feature-flags.ts`, these are reviewed constants, not env vars: the value per
 * deployment target is fixed here and only the deployment target is read.
 */

export type DeployTarget = "production" | "preview" | "development";

/**
 * Orca Whirlpools read-only pool discovery (`/api/protocol-pools`).
 * OFF in production. Enabled on Vercel preview/development deployments so it
 * can be verified there. Anything that is not an explicit Vercel preview or
 * development deployment (including self-hosted builds) counts as production.
 */
export const ORCA_DISCOVERY_ENABLED: Readonly<Record<DeployTarget, boolean>> = Object.freeze({
  production: false,
  preview: true,
  development: true,
});

export function deployTarget(vercelEnv: string | undefined = process.env.VERCEL_ENV): DeployTarget {
  return vercelEnv === "preview" || vercelEnv === "development" ? vercelEnv : "production";
}

export function isOrcaDiscoveryEnabled(target: DeployTarget = deployTarget()): boolean {
  return ORCA_DISCOVERY_ENABLED[target];
}

/**
 * Orca Whirlpools read-only positions in MCP `list_positions` /
 * `get_position_performance` / `get_position_range_status` (allowlisted pools,
 * SoFinance-opened positions only). OFF in production, same targets as above.
 */
export const ORCA_POSITIONS_ENABLED: Readonly<Record<DeployTarget, boolean>> = Object.freeze({
  production: false,
  preview: true,
  development: true,
});

export function isOrcaPositionsEnabled(target: DeployTarget = deployTarget()): boolean {
  return ORCA_POSITIONS_ENABLED[target];
}

/**
 * Uniswap v4 on Robinhood Chain (4663): read-only discovery of the allowlisted
 * StablePairHook pools (`/api/protocol-pools?protocol=uniswap-v4-rhc`). OFF in
 * production, same targets as above. Nothing on this path signs or sends.
 */
export const RHC_UNIV4_DISCOVERY_ENABLED: Readonly<Record<DeployTarget, boolean>> = Object.freeze({
  production: false,
  preview: true,
  development: true,
});

export function isRhcUniv4DiscoveryEnabled(target: DeployTarget = deployTarget()): boolean {
  return RHC_UNIV4_DISCOVERY_ENABLED[target];
}

/**
 * Every Solami integration: Blur live pool activity (the MCP `get_pool_activity`
 * tool, the `/api/pool-activity` snapshot and `/api/pool-activity/stream` SSE
 * routes, the app's pool-activity panel / live ticker, and the Blur price in
 * `get_position_range_status`), Solami RPC (the built-in `solami` provider and
 * any SOLANA_RPC_PROVIDERS / SOLANA_RPC_URL endpoint on *.solami.dev), and Beam
 * (tip addresses and landing lookups). OFF in production (the Solami account is
 * on the Free plan): no Solami request or socket is attempted, the MCP tool is
 * hidden from tools/list, `get_position_range_status` uses the on-chain price,
 * and RPC goes to the remaining providers. Enabled on Vercel preview/development.
 */
export const SOLAMI_ENABLED: Readonly<Record<DeployTarget, boolean>> = Object.freeze({
  production: false,
  preview: true,
  development: true,
});

export function isSolamiEnabled(target: DeployTarget = deployTarget()): boolean {
  return SOLAMI_ENABLED[target];
}

/**
 * Client-side read of the same flag. `NEXT_PUBLIC_SOFI_DEPLOY_ENV` is inlined
 * from `VERCEL_ENV` at build time (next.config.ts); `VERCEL_ENV` covers server
 * renders and tests.
 */
export function isSolamiEnabledInBrowser(): boolean {
  return isSolamiEnabled(deployTarget(process.env.NEXT_PUBLIC_SOFI_DEPLOY_ENV || process.env.VERCEL_ENV));
}

/** Pool activity is a Solami feature: same flag (kept as an alias, identical behaviour). */
export const POOL_ACTIVITY_ENABLED = SOLAMI_ENABLED;
export const isPoolActivityEnabled = isSolamiEnabled;
export const isPoolActivityEnabledInBrowser = isSolamiEnabledInBrowser;

export const POOL_ACTIVITY_DISABLED_MESSAGE = "get_pool_activity is disabled on this deployment.";

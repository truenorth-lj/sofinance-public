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
 * Solami Blur live pool activity: the MCP `get_pool_activity` tool, the
 * `/api/pool-activity` snapshot and `/api/pool-activity/stream` SSE routes, and
 * the app's pool-activity panel / live ticker. OFF in production (the Solami
 * account is on the Free plan, which serves neither the snapshot nor the
 * stream); when off, no Solami request or socket is attempted and the MCP tool
 * is hidden from tools/list. Enabled on Vercel preview/development.
 * `get_position_range_status` is not gated: it falls back to the on-chain mid.
 */
export const POOL_ACTIVITY_ENABLED: Readonly<Record<DeployTarget, boolean>> = Object.freeze({
  production: false,
  preview: true,
  development: true,
});

export function isPoolActivityEnabled(target: DeployTarget = deployTarget()): boolean {
  return POOL_ACTIVITY_ENABLED[target];
}

/**
 * Client-side read of the same flag. `NEXT_PUBLIC_SOFI_DEPLOY_ENV` is inlined
 * from `VERCEL_ENV` at build time (next.config.ts); `VERCEL_ENV` covers server
 * renders and tests.
 */
export function isPoolActivityEnabledInBrowser(): boolean {
  return isPoolActivityEnabled(deployTarget(process.env.NEXT_PUBLIC_SOFI_DEPLOY_ENV || process.env.VERCEL_ENV));
}

export const POOL_ACTIVITY_DISABLED_MESSAGE = "get_pool_activity is disabled on this deployment.";

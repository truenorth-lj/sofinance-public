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
 * Every remaining Solami integration: Solami RPC (the built-in `solami`
 * provider and any SOLANA_RPC_PROVIDERS / SOLANA_RPC_URL endpoint on
 * *.solami.dev, including `getTransactionsForAddress` history) and Beam (tip
 * addresses and landing lookups), wired into the engine via
 * `src/lib/engine-host.ts`. OFF in production: no Solami request is attempted
 * and RPC goes to the remaining providers. Enabled on Vercel preview/development
 * (where it still needs SOLAMI_API_KEY / a Solami RPC URL to do anything).
 */
export const SOLAMI_ENABLED: Readonly<Record<DeployTarget, boolean>> = Object.freeze({
  production: false,
  preview: true,
  development: true,
});

export function isSolamiEnabled(target: DeployTarget = deployTarget()): boolean {
  return SOLAMI_ENABLED[target];
}

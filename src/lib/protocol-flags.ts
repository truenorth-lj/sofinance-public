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

// Client bundles have no VERCEL_ENV; next.config inlines it as NEXT_PUBLIC_SOFI_DEPLOY_ENV at build time.
export function deployTarget(vercelEnv: string | undefined = process.env.NEXT_PUBLIC_SOFI_DEPLOY_ENV || process.env.VERCEL_ENV): DeployTarget {
  return vercelEnv === "preview" || vercelEnv === "development" ? vercelEnv : "production";
}

export function isOrcaDiscoveryEnabled(target: DeployTarget = deployTarget()): boolean {
  return ORCA_DISCOVERY_ENABLED[target];
}

/**
 * Orca Whirlpools read-only positions in MCP `list_positions` /
 * `get_position_performance` / `get_position_range_status` (positions the wallet
 * holds on-chain in allowlisted pools). OFF in production, same targets as above.
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
 * StablePairHook pools (`/api/protocol-pools?protocol=uniswap-v4-rhc`). Enabled in
 * production, preview and development. Nothing on this path signs or sends.
 */
export const RHC_UNIV4_DISCOVERY_ENABLED: Readonly<Record<DeployTarget, boolean>> = Object.freeze({
  production: true,
  preview: true,
  development: true,
});

export function isRhcUniv4DiscoveryEnabled(target: DeployTarget = deployTarget()): boolean {
  return RHC_UNIV4_DISCOVERY_ENABLED[target];
}

/**
 * Uniswap v4 on Robinhood Chain: server-side BUILD + eth_simulateV1 of the open-position
 * transaction (`POST /api/rhc-univ4-open`). Enabled in production, preview and development.
 * The route returns unsigned calldata and Permit2 typed data only: it never signs, never
 * broadcasts. The fee recipient is the server-only env `RHC_UNIV4_FEE_WALLET`; unset/invalid fails closed.
 */
export const RHC_UNIV4_TX_BUILD_ENABLED: Readonly<Record<DeployTarget, boolean>> = Object.freeze({
  production: true,
  preview: true,
  development: true,
});

export function isRhcUniv4TxBuildEnabled(target: DeployTarget = deployTarget()): boolean {
  return RHC_UNIV4_TX_BUILD_ENABLED[target];
}

/**
 * Uniswap v4 on Robinhood Chain: the open-position page and EVM wallet flow (`/app/rhc`,
 * design §6 PR5): MetaMask connect, chain 4663 add/switch, Permit2 approve → sign → execute
 * UX and the open preview. Enabled in production, preview and development.
 */
export const RHC_UNIV4_TRADING_ENABLED: Readonly<Record<DeployTarget, boolean>> = Object.freeze({
  production: true,
  preview: true,
  development: true,
});

export function isRhcUniv4TradingEnabled(target: DeployTarget = deployTarget()): boolean {
  return RHC_UNIV4_TRADING_ENABLED[target];
}

/**
 * Real wallet requests that sign or send on Robinhood Chain (`approve(Permit2)`, the Permit2
 * signature, `execute`). Enabled in production and Vercel preview; disabled in local
 * development. These constants describe configuration, not financial validation.
 */
export const RHC_UNIV4_WALLET_SIGNING_ENABLED: Readonly<Record<DeployTarget, boolean>> = Object.freeze({
  production: true,
  preview: true,
  development: false,
});

export function isRhcUniv4WalletSigningEnabled(target: DeployTarget = deployTarget()): boolean {
  return RHC_UNIV4_WALLET_SIGNING_ENABLED[target];
}

/**
 * Meteora DLMM read-only pool discovery (`/api/protocol-pools?protocol=meteora-dlmm`) and pool state,
 * bin-array liquidity and estimated range APR (`/api/protocol-pools/range-apr?protocol=meteora-dlmm`).
 * OFF in production, same targets as above. Nothing on this path signs or sends.
 */
export const METEORA_DLMM_DISCOVERY_ENABLED: Readonly<Record<DeployTarget, boolean>> = Object.freeze({
  production: false,
  preview: true,
  development: true,
});

export function isMeteoraDlmmDiscoveryEnabled(target: DeployTarget = deployTarget()): boolean {
  return METEORA_DLMM_DISCOVERY_ENABLED[target];
}

/**
 * Meteora DLMM open flow: build + simulate the 1/2 setup (position account, user ATAs) and 2/2 deposit
 * (Jupiter legs with the 10 bps platform fee on the swapped portion + add_liquidity_by_strategy2), and
 * the close-and-refund transaction (`/api/meteora-open`, `/app/meteora`). OFF in production.
 * Building never signs or sends.
 */
export const METEORA_DLMM_TX_BUILD_ENABLED: Readonly<Record<DeployTarget, boolean>> = Object.freeze({
  production: false,
  preview: true,
  development: true,
});

export function isMeteoraDlmmTxBuildEnabled(target: DeployTarget = deployTarget()): boolean {
  return METEORA_DLMM_TX_BUILD_ENABLED[target];
}

/**
 * Wallet signing for the Meteora open flow (Phantom / Jupiter Wallet sign buttons, server broadcast of the
 * wallet-signed tx after permit + fee-guard checks, status, and recording landed opens in the opens log).
 * Preview + development only; OFF in production.
 */
export const METEORA_DLMM_WALLET_SIGNING_ENABLED: Readonly<Record<DeployTarget, boolean>> = Object.freeze({
  production: false,
  preview: true,
  development: true,
});

export function isMeteoraDlmmWalletSigningEnabled(target: DeployTarget = deployTarget()): boolean {
  return METEORA_DLMM_WALLET_SIGNING_ENABLED[target];
}

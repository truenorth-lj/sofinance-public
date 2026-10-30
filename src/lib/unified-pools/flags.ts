import {
  type DeployTarget, deployTarget, isMeteoraDlmmDiscoveryEnabled, isMeteoraDlmmTxBuildEnabled, isOrcaDiscoveryEnabled,
  isRhcUniv4DiscoveryEnabled, isRhcUniv4TradingEnabled, isRhcUniv4WalletSigningEnabled,
} from "@/lib/protocol-flags";

/**
 * Which pool sources and open flows `/app` shows on a deployment, from the code flags in `protocol-flags.ts`.
 * Production shows nothing whose flag is off there (today: Raydium + Robinhood Chain; Orca and Meteora stay hidden).
 */
export function unifiedPoolFlags(target: DeployTarget = deployTarget()) {
  const rhc = isRhcUniv4DiscoveryEnabled(target) && isRhcUniv4TradingEnabled(target);
  return {
    orca: isOrcaDiscoveryEnabled(target),
    meteora: isMeteoraDlmmDiscoveryEnabled(target),
    meteoraOpen: isMeteoraDlmmDiscoveryEnabled(target) && isMeteoraDlmmTxBuildEnabled(target),
    rhc,
    rhcSigning: rhc && isRhcUniv4WalletSigningEnabled(target),
  };
}

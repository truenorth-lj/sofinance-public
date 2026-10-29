import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deployTarget, isOrcaDiscoveryEnabled, isOrcaPositionsEnabled, isRhcUniv4DiscoveryEnabled, isRhcUniv4TxBuildEnabled, ORCA_DISCOVERY_ENABLED, ORCA_POSITIONS_ENABLED, RHC_UNIV4_DISCOVERY_ENABLED, RHC_UNIV4_TX_BUILD_ENABLED, isRhcUniv4TradingEnabled, RHC_UNIV4_TRADING_ENABLED, isRhcUniv4WalletSigningEnabled, RHC_UNIV4_WALLET_SIGNING_ENABLED } from "./protocol-flags";

describe("ORCA_DISCOVERY_ENABLED", () => {
  it("is a code constant that is OFF in production", () => {
    expect(ORCA_DISCOVERY_ENABLED).toEqual({ production: false, preview: true, development: true });
    expect(Object.isFrozen(ORCA_DISCOVERY_ENABLED)).toBe(true);
    expect(isOrcaDiscoveryEnabled("production")).toBe(false);
    expect(isOrcaDiscoveryEnabled("preview")).toBe(true);
  });
  it("ORCA_POSITIONS_ENABLED is a frozen code constant that is OFF in production", () => {
    expect(ORCA_POSITIONS_ENABLED).toEqual({ production: false, preview: true, development: true });
    expect(Object.isFrozen(ORCA_POSITIONS_ENABLED)).toBe(true);
    expect(isOrcaPositionsEnabled("production")).toBe(false);
    expect(isOrcaPositionsEnabled("preview")).toBe(true);
  });
  it("RHC_UNIV4_DISCOVERY_ENABLED is a frozen code constant that is OFF in production", () => {
    expect(RHC_UNIV4_DISCOVERY_ENABLED).toEqual({ production: false, preview: true, development: true });
    expect(Object.isFrozen(RHC_UNIV4_DISCOVERY_ENABLED)).toBe(true);
    expect(isRhcUniv4DiscoveryEnabled("production")).toBe(false);
    expect(isRhcUniv4DiscoveryEnabled("preview")).toBe(true);
  });
  it("RHC_UNIV4_TX_BUILD_ENABLED is a frozen code constant that is OFF in production", () => {
    expect(RHC_UNIV4_TX_BUILD_ENABLED).toEqual({ production: false, preview: true, development: true });
    expect(Object.isFrozen(RHC_UNIV4_TX_BUILD_ENABLED)).toBe(true);
    expect(isRhcUniv4TxBuildEnabled("production")).toBe(false);
    expect(isRhcUniv4TxBuildEnabled("preview")).toBe(true);
  });
  it("RHC_UNIV4_TRADING_ENABLED is a frozen code constant that is OFF in production", () => {
    expect(RHC_UNIV4_TRADING_ENABLED).toEqual({ production: false, preview: true, development: true });
    expect(Object.isFrozen(RHC_UNIV4_TRADING_ENABLED)).toBe(true);
    expect(isRhcUniv4TradingEnabled("production")).toBe(false);
    expect(isRhcUniv4TradingEnabled("preview")).toBe(true);
  });
  it("RHC_UNIV4_WALLET_SIGNING_ENABLED is ON only on preview", () => {
    expect(RHC_UNIV4_WALLET_SIGNING_ENABLED).toEqual({ production: false, preview: true, development: false });
    expect(Object.isFrozen(RHC_UNIV4_WALLET_SIGNING_ENABLED)).toBe(true);
    expect(isRhcUniv4WalletSigningEnabled("preview")).toBe(true);
    for (const t of ["production", "development"] as const) expect(isRhcUniv4WalletSigningEnabled(t)).toBe(false);
  });
  it("treats anything that is not an explicit Vercel preview/development as production", () => {
    for (const env of [undefined, "", "production", "staging", "PREVIEW"]) expect(deployTarget(env)).toBe("production");
    expect(deployTarget("preview")).toBe("preview");
    expect(deployTarget("development")).toBe("development");
  });
  it("is not driven by a SOFINANCE_* env var", () => {
    const source = readFileSync(join(__dirname, "protocol-flags.ts"), "utf8");
    expect(source.match(/process\.env\.[A-Z_]+/g)).toEqual(["process.env.NEXT_PUBLIC_SOFI_DEPLOY_ENV", "process.env.VERCEL_ENV"]);
  });
});

describe("Raydium discovery is untouched by Orca", () => {
  it("the /api/rwa-pairs feed never imports Orca discovery or the protocol flag", () => {
    for (const file of ["src/lib/rwa-pairs.ts", "src/lib/rwa-store.ts", "src/lib/rwa-postgres-store.ts", "src/app/api/rwa-pairs/route.ts"]) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, file).not.toMatch(/orca|protocol-flags|protocol-pools/i);
    }
  });

  it("the Raydium range-APR path (/api/pool-range-apr) never imports Orca code or the protocol flag", () => {
    for (const file of ["src/lib/pool-range-apr.ts", "src/lib/range-apr/onchain-liquidity.ts", "src/lib/range-apr/raydium-economics.ts", "src/app/api/pool-range-apr/route.ts"]) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, file).not.toMatch(/orca|protocol-flags|protocol-pools/i);
    }
  });

  it("the Raydium position readers never import Orca code or the protocol flag", () => {
    for (const file of ["src/lib/position-performance.ts", "src/lib/position-performance-events.ts", "src/lib/position-range-onchain.ts"]) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, file).not.toMatch(/orca|protocol-flags/i);
    }
  });
});

describe("Raydium and Orca are untouched by Robinhood Chain", () => {
  it("existing feeds and readers never import Robinhood Chain / Uniswap v4 / EVM code", () => {
    for (const file of [
      "src/lib/rwa-pairs.ts", "src/lib/rwa-store.ts", "src/lib/rwa-postgres-store.ts", "src/app/api/rwa-pairs/route.ts",
      "src/lib/pool-range-apr.ts", "src/app/api/pool-range-apr/route.ts", "src/lib/orca-pairs.ts", "src/lib/orca-range-apr.ts",
      "src/lib/orca-positions.ts", "src/mcp/tools.ts",
    ]) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, file).not.toMatch(/rhc|uniswap|rpc-evm|viem/i);
    }
  });
});

describe("deployTarget env resolution", () => {
  it("prefers the build-inlined NEXT_PUBLIC_SOFI_DEPLOY_ENV (client bundles have no VERCEL_ENV)", () => {
    vi.stubEnv("NEXT_PUBLIC_SOFI_DEPLOY_ENV", "preview"); vi.stubEnv("VERCEL_ENV", "");
    expect(deployTarget()).toBe("preview");
    expect(isRhcUniv4WalletSigningEnabled()).toBe(true);
    vi.stubEnv("NEXT_PUBLIC_SOFI_DEPLOY_ENV", "production");
    expect(isRhcUniv4WalletSigningEnabled()).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_SOFI_DEPLOY_ENV", ""); vi.stubEnv("VERCEL_ENV", "");
    expect(deployTarget()).toBe("production");
    vi.unstubAllEnvs();
  });
});

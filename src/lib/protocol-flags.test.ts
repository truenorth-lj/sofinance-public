import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deployTarget, isOrcaDiscoveryEnabled, isOrcaPositionsEnabled, isRhcUniv4DiscoveryEnabled, isRhcUniv4TxBuildEnabled, ORCA_DISCOVERY_ENABLED, ORCA_POSITIONS_ENABLED, RHC_UNIV4_DISCOVERY_ENABLED, RHC_UNIV4_TX_BUILD_ENABLED, isRhcUniv4TradingEnabled, RHC_UNIV4_TRADING_ENABLED, isRhcUniv4WalletSigningEnabled, RHC_UNIV4_WALLET_SIGNING_ENABLED, isMeteoraDlmmDiscoveryEnabled, METEORA_DLMM_DISCOVERY_ENABLED } from "./protocol-flags";

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
  it("RHC_UNIV4_DISCOVERY_ENABLED is a frozen code constant, ON in production since the 2026-10-29 launch", () => {
    expect(RHC_UNIV4_DISCOVERY_ENABLED).toEqual({ production: true, preview: true, development: true });
    expect(Object.isFrozen(RHC_UNIV4_DISCOVERY_ENABLED)).toBe(true);
    expect(isRhcUniv4DiscoveryEnabled("production")).toBe(true);
    expect(isRhcUniv4DiscoveryEnabled("preview")).toBe(true);
  });
  it("RHC_UNIV4_TX_BUILD_ENABLED is a frozen code constant, ON in production since the 2026-10-29 launch", () => {
    expect(RHC_UNIV4_TX_BUILD_ENABLED).toEqual({ production: true, preview: true, development: true });
    expect(Object.isFrozen(RHC_UNIV4_TX_BUILD_ENABLED)).toBe(true);
    expect(isRhcUniv4TxBuildEnabled("production")).toBe(true);
    expect(isRhcUniv4TxBuildEnabled("preview")).toBe(true);
  });
  it("RHC_UNIV4_TRADING_ENABLED is a frozen code constant, ON in production since the 2026-10-29 launch", () => {
    expect(RHC_UNIV4_TRADING_ENABLED).toEqual({ production: true, preview: true, development: true });
    expect(Object.isFrozen(RHC_UNIV4_TRADING_ENABLED)).toBe(true);
    expect(isRhcUniv4TradingEnabled("production")).toBe(true);
    expect(isRhcUniv4TradingEnabled("preview")).toBe(true);
  });
  it("RHC_UNIV4_WALLET_SIGNING_ENABLED is ON in production and preview, off in development", () => {
    expect(RHC_UNIV4_WALLET_SIGNING_ENABLED).toEqual({ production: true, preview: true, development: false });
    expect(Object.isFrozen(RHC_UNIV4_WALLET_SIGNING_ENABLED)).toBe(true);
    for (const t of ["production", "preview"] as const) expect(isRhcUniv4WalletSigningEnabled(t)).toBe(true);
    expect(isRhcUniv4WalletSigningEnabled("development")).toBe(false);
  });
  it("METEORA_DLMM_DISCOVERY_ENABLED is a frozen code constant that is OFF in production", () => {
    expect(METEORA_DLMM_DISCOVERY_ENABLED).toEqual({ production: false, preview: true, development: true });
    expect(Object.isFrozen(METEORA_DLMM_DISCOVERY_ENABLED)).toBe(true);
    expect(isMeteoraDlmmDiscoveryEnabled("production")).toBe(false);
    expect(isMeteoraDlmmDiscoveryEnabled("preview")).toBe(true);
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

describe("Raydium, Orca and Robinhood Chain are untouched by Meteora", () => {
  it("existing feeds and readers never import Meteora code", () => {
    for (const file of [
      "src/lib/rwa-pairs.ts", "src/lib/rwa-store.ts", "src/lib/rwa-postgres-store.ts", "src/app/api/rwa-pairs/route.ts",
      "src/lib/pool-range-apr.ts", "src/app/api/pool-range-apr/route.ts", "src/lib/orca-pairs.ts", "src/lib/orca-range-apr.ts",
      "src/lib/orca-positions.ts", "src/lib/rhc-univ4-pools.ts",
    ]) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, file).not.toMatch(/meteora|dlmm/i);
    }
  });

  it("MCP tools reach Meteora position readers only behind METEORA_DLMM_DISCOVERY_ENABLED", () => {
    const source = readFileSync(join(process.cwd(), "src/mcp/tools.ts"), "utf8");
    const calls = source.split("\n").filter((line) => /(listMeteoraPositions|readMeteoraPositionRangeFacts)\(/.test(line));
    expect(calls).toHaveLength(2);
    for (const line of calls) expect(line).toContain("isMeteoraDlmmDiscoveryEnabled()");
  });
});

describe("deployTarget env resolution", () => {
  it("prefers the build-inlined NEXT_PUBLIC_SOFI_DEPLOY_ENV (client bundles have no VERCEL_ENV)", () => {
    vi.stubEnv("NEXT_PUBLIC_SOFI_DEPLOY_ENV", "preview"); vi.stubEnv("VERCEL_ENV", "");
    expect(deployTarget()).toBe("preview");
    expect(isRhcUniv4WalletSigningEnabled()).toBe(true);
    vi.stubEnv("NEXT_PUBLIC_SOFI_DEPLOY_ENV", "development"); vi.stubEnv("VERCEL_ENV", "production");
    expect(deployTarget()).toBe("development");
    expect(isRhcUniv4WalletSigningEnabled()).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_SOFI_DEPLOY_ENV", ""); vi.stubEnv("VERCEL_ENV", "");
    expect(deployTarget()).toBe("production");
    vi.unstubAllEnvs();
  });
});

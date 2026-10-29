import { afterEach, describe, expect, it } from "vitest";
import { configureEngine, engineEnv, isEngineConfigured, resetEngineHost } from "./host";
import { readSwapFeeConfig } from "./swap/fee";
import { resolveProviderPair } from "./rpc/providers";

afterEach(() => configureEngine({ env: () => process.env }));

describe("engine host injection", () => {
  it("refuses to run unconfigured instead of silently reading process.env", () => {
    resetEngineHost();
    expect(isEngineConfigured()).toBe(false);
    expect(() => engineEnv()).toThrow("configureEngine");
    expect(() => readSwapFeeConfig()).toThrow("configureEngine");
  });
  it("reads the injected configuration on every call (rotations are seen immediately)", () => {
    let env: Record<string, string | undefined> = { SOFINANCE_FEE_WALLET: "CS5CWYgXTsbbHU8DznjsCqLdCLAB5ms6PVnTyjDtA1Bf", SOFINANCE_FEE_BPS: "10" };
    configureEngine({ env: () => env });
    expect(readSwapFeeConfig()).toMatchObject({ bps: 10 });
    expect(readSwapFeeConfig().wallet?.toBase58()).toBe("CS5CWYgXTsbbHU8DznjsCqLdCLAB5ms6PVnTyjDtA1Bf");
    env = { ...env, SOFINANCE_FEE_BPS: "25" };
    expect(readSwapFeeConfig().bps).toBe(25);
    env = { SOFINANCE_FEE_BPS: "25", SOFINANCE_FEE_WALLET: "" };
    expect(readSwapFeeConfig().wallet).toBeNull();
  });
  it("never consults process.env when the host injects a different snapshot", () => {
    process.env.SOLANA_RPC_URL = "https://ambient.invalid";
    configureEngine({ env: () => ({ SOLANA_RPC_URL: "https://injected.example" }) });
    expect(resolveProviderPair().primary.endpoint).toBe("https://injected.example");
    delete process.env.SOLANA_RPC_URL;
  });
});

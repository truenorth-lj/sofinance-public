import { afterEach, describe, expect, it } from "vitest";
import { configureEngine, engineEnv, isEngineConfigured, isSolamiEndpoint, resetEngineHost, solamiAllowed } from "./host";
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
  it("allows Solami unless the host's solamiEnabled hook says otherwise", () => {
    expect(solamiAllowed()).toBe(true);
    let enabled = false;
    configureEngine({ env: () => ({ SOLAMI_API_KEY: "k", SOLANA_RPC_URL: "https://injected.example" }), solamiEnabled: () => enabled });
    expect(solamiAllowed()).toBe(false);
    expect(resolveProviderPair().primary.id).toBe("generic");
    enabled = true;
    expect(resolveProviderPair().primary.id).toBe("solami");
  });
  it("recognises Solami endpoints by host only", () => {
    expect(isSolamiEndpoint("https://rpc.solami.dev/sol?api_key=k")).toBe(true);
    expect(isSolamiEndpoint("https://api.solami.dev/swqos/tx/x")).toBe(true);
    expect(isSolamiEndpoint("wss://ws.solami.dev")).toBe(true);
    expect(isSolamiEndpoint("https://solami.dev")).toBe(true);
    expect(isSolamiEndpoint("https://notsolami.dev")).toBe(false);
    expect(isSolamiEndpoint("https://example.com/?u=rpc.solami.dev")).toBe(false);
    expect(isSolamiEndpoint("not a url")).toBe(false);
  });
});

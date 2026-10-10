import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  PUBLIC_SOLANA_RPC_URL,
  SOLAMI_RPC_BASE_URL,
  redactRpcEndpoint,
  resolveDefaultRpcConfig,
  resolveProviderPair,
  resolveRpcConfig,
  rpcProvider,
} from "./rpc";

describe("resolveRpcConfig", () => {
  const originalSolami = process.env.SOLAMI_API_KEY;
  const originalRpc = process.env.SOLANA_RPC_URL;

  afterEach(() => {
    if (originalSolami === undefined) delete process.env.SOLAMI_API_KEY;
    else process.env.SOLAMI_API_KEY = originalSolami;
    if (originalRpc === undefined) delete process.env.SOLANA_RPC_URL;
    else process.env.SOLANA_RPC_URL = originalRpc;
  });

  it("prefers Solami when SOLAMI_API_KEY is set, even if SOLANA_RPC_URL is also set", () => {
    const config = resolveRpcConfig({
      SOLAMI_API_KEY: " test-key ",
      SOLANA_RPC_URL: "https://example.rpc/secret",
    });
    expect(config.provider).toBe("solami");
    expect(config.endpoint).toBe(`${SOLAMI_RPC_BASE_URL}?api_key=test-key`);
    expect(rpcProvider({ SOLAMI_API_KEY: "test-key" })).toBe("solami");
  });

  it("uses SOLANA_RPC_URL when no Solami key is present", () => {
    const config = resolveRpcConfig({
      SOLAMI_API_KEY: "   ",
      SOLANA_RPC_URL: "https://dedicated.example/rpc",
    });
    expect(config).toEqual({
      endpoint: "https://dedicated.example/rpc",
      provider: "default",
    });
  });

  it("falls back to the public mainnet RPC when nothing is configured", () => {
    const config = resolveRpcConfig({});
    expect(config).toEqual({
      endpoint: PUBLIC_SOLANA_RPC_URL,
      provider: "default",
    });
  });
});

describe("resolveDefaultRpcConfig", () => {
  it("ignores SOLAMI_API_KEY and uses SOLANA_RPC_URL then public", () => {
    expect(
      resolveDefaultRpcConfig({
        SOLAMI_API_KEY: "test-key",
        SOLANA_RPC_URL: "https://dedicated.example/rpc",
      }),
    ).toEqual({
      endpoint: "https://dedicated.example/rpc",
      provider: "default",
    });
    expect(resolveDefaultRpcConfig({ SOLAMI_API_KEY: "test-key" })).toEqual({
      endpoint: PUBLIC_SOLANA_RPC_URL,
      provider: "default",
    });
  });
});

describe("resolveProviderPair", () => {
  it("selects Solami as primary and the dedicated URL as fallback", () => {
    const pair = resolveProviderPair({
      SOLAMI_API_KEY: "k",
      SOLANA_RPC_URL: "https://helius.example/rpc",
    });
    expect(pair.primary.id).toBe("solami");
    expect(pair.primary.customMethods).toContain("getTransactionsForAddress");
    expect(pair.fallback?.id).toBe("generic");
    expect(pair.fallback?.metricId).toBe("default");
    expect(pair.fallback?.endpoint).toBe("https://helius.example/rpc");
  });

  it("uses public as fallback when only Solami is configured", () => {
    const pair = resolveProviderPair({ SOLAMI_API_KEY: "k" });
    expect(pair.primary.metricId).toBe("solami");
    expect(pair.fallback?.id).toBe("public");
  });
});

describe("redactRpcEndpoint", () => {
  it("drops the credential-bearing query string", () => {
    expect(redactRpcEndpoint(`${SOLAMI_RPC_BASE_URL}?api_key=super-secret`)).toBe(
      "https://rpc.solami.dev/sol",
    );
  });

  it("returns a safe label for unparseable values", () => {
    expect(redactRpcEndpoint("not a url")).toBe("rpc");
  });
});

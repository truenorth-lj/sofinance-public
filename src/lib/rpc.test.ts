import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Solami-on behaviour (SOLAMI_ENABLED is on for Vercel preview/development, off in production).
beforeEach(() => { vi.stubEnv("VERCEL_ENV", "preview"); });
afterEach(() => { vi.unstubAllEnvs(); });

vi.mock("server-only", () => ({}));

import {
  PUBLIC_SOLANA_RPC_URL,
  SOLAMI_RPC_BASE_URL,
  redactRpcEndpoint,
  resolveDefaultRpcConfig,
  resolveRpcPool,
  resolveProviderPair,
  resolveRpcConfig,
  rpcProvider,
} from "@sofinance/engine/rpc";

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

describe("SOLAMI_ENABLED off (production): no Solami RPC", () => {
  it.each([undefined, "production"])("drops the built-in Solami provider and any *.solami.dev endpoint (VERCEL_ENV=%s)", (vercelEnv) => {
    vi.stubEnv("VERCEL_ENV", vercelEnv);
    const pair = resolveProviderPair({ SOLAMI_API_KEY: "k", SOLANA_RPC_URL: "https://helius.example/rpc" });
    expect(pair.primary.id).toBe("generic");
    expect(pair.primary.endpoint).toBe("https://helius.example/rpc");
    // A SOLANA_RPC_URL that points at Solami is skipped too: public RPC serves instead.
    expect(resolveProviderPair({ SOLANA_RPC_URL: "https://rpc.solami.dev/sol?api_key=k" }).primary.id).toBe("public");
    const pool = resolveRpcPool({
      SOLAMI_API_KEY: "k",
      SOLAMI_RPC_URL: "https://rpc.solami.dev/sol?api_key=k",
      ALCHEMY_RPC_URL: "https://alchemy.example/v2/x",
      SOLANA_RPC_PROVIDERS: JSON.stringify([
        { name: "alchemy", url: "$ALCHEMY_RPC_URL", transactions: true },
        { name: "solami", url: "$SOLAMI_RPC_URL", transactions: true },
        { name: "solami-builtin", url: "$SOLAMI" },
        { name: "solami-literal", url: "https://api.solami.dev/rpc" },
      ]),
    });
    const endpoints = [...pool.read, ...pool.transaction].map((member) => member.endpoint);
    expect(pool.source).toBe("env");
    expect(endpoints).toEqual(["https://alchemy.example/v2/x", "https://alchemy.example/v2/x"]);
  });

  it("falls back to the legacy pair (never Solami) when only Solami providers were listed", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const pool = resolveRpcPool({
      SOLAMI_API_KEY: "k",
      SOLANA_RPC_URL: "https://helius.example/rpc",
      SOLANA_RPC_PROVIDERS: JSON.stringify([{ name: "solami", url: "$SOLAMI", transactions: true }]),
    });
    const endpoints = [...pool.read, ...pool.transaction].map((member) => member.endpoint);
    expect(endpoints.some((endpoint) => endpoint.includes("solami.dev"))).toBe(false);
    expect(endpoints).toContain("https://helius.example/rpc");
  });

  it("keeps Solami providers on preview (unchanged)", () => {
    const pool = resolveRpcPool({
      SOLAMI_RPC_URL: "https://rpc.solami.dev/sol?api_key=k",
      SOLANA_RPC_PROVIDERS: JSON.stringify([{ name: "solami", url: "$SOLAMI_RPC_URL" }]),
    });
    expect(pool.read.map((member) => member.name)).toEqual(["solami"]);
    expect(resolveProviderPair({ SOLAMI_API_KEY: "k" }).primary.id).toBe("solami");
  });
});

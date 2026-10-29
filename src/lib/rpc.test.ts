import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  PUBLIC_SOLANA_RPC_URL,
  RETIRED_RPC_HOSTS,
  isRetiredRpcEndpoint,
  redactRpcEndpoint,
  resolveDefaultRpcConfig,
  resolveRpcPool,
  resolveProviderPair,
  resolveRpcConfig,
  rpcProvider,
} from "@sofinance/engine/rpc";

// A stale endpoint on a retired vendor host (still possibly present in deployed env vars).
const RETIRED = `https://rpc.${RETIRED_RPC_HOSTS[0]}/sol?api_key=k`;

describe("resolveRpcConfig", () => {
  const originalRpc = process.env.SOLANA_RPC_URL;

  afterEach(() => {
    if (originalRpc === undefined) delete process.env.SOLANA_RPC_URL;
    else process.env.SOLANA_RPC_URL = originalRpc;
  });

  it("uses SOLANA_RPC_URL when present", () => {
    const config = resolveRpcConfig({ SOLANA_RPC_URL: "https://dedicated.example/rpc" });
    expect(config).toEqual({
      endpoint: "https://dedicated.example/rpc",
      provider: "default",
    });
    expect(rpcProvider({ SOLANA_RPC_URL: "https://dedicated.example/rpc" })).toBe("default");
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
  it("uses SOLANA_RPC_URL then public", () => {
    expect(resolveDefaultRpcConfig({ SOLANA_RPC_URL: "https://dedicated.example/rpc" })).toEqual({
      endpoint: "https://dedicated.example/rpc",
      provider: "default",
    });
    expect(resolveDefaultRpcConfig({})).toEqual({
      endpoint: PUBLIC_SOLANA_RPC_URL,
      provider: "default",
    });
  });
});

describe("resolveProviderPair", () => {
  it("selects the dedicated URL as primary and public as fallback", () => {
    const pair = resolveProviderPair({ SOLANA_RPC_URL: "https://helius.example/rpc" });
    expect(pair.primary.id).toBe("generic");
    expect(pair.primary.metricId).toBe("default");
    expect(pair.primary.endpoint).toBe("https://helius.example/rpc");
    expect(pair.fallback?.id).toBe("public");
  });
});

describe("redactRpcEndpoint", () => {
  it("drops the credential-bearing query string", () => {
    expect(redactRpcEndpoint("https://helius.example/rpc?api-key=super-secret")).toBe(
      "https://helius.example/rpc",
    );
  });

  it("returns a safe label for unparseable values", () => {
    expect(redactRpcEndpoint("not a url")).toBe("rpc");
  });
});

describe("retired RPC hosts are never used", () => {
  it("recognises the retired host and its subdomains only", () => {
    expect(isRetiredRpcEndpoint(RETIRED)).toBe(true);
    expect(isRetiredRpcEndpoint(`https://${RETIRED_RPC_HOSTS[0]}/rpc`)).toBe(true);
    expect(isRetiredRpcEndpoint(`https://not${RETIRED_RPC_HOSTS[0]}/rpc`)).toBe(false);
    expect(isRetiredRpcEndpoint("https://helius.example/rpc")).toBe(false);
    expect(isRetiredRpcEndpoint("not a url")).toBe(false);
  });

  it("skips a SOLANA_RPC_URL on a retired host: public RPC serves instead", () => {
    expect(resolveProviderPair({ SOLANA_RPC_URL: RETIRED }).primary.id).toBe("public");
  });

  it("drops retired endpoints from SOLANA_RPC_PROVIDERS", () => {
    const pool = resolveRpcPool({
      OLD_RPC_URL: RETIRED,
      ALCHEMY_RPC_URL: "https://alchemy.example/v2/x",
      SOLANA_RPC_PROVIDERS: JSON.stringify([
        { name: "alchemy", url: "$ALCHEMY_RPC_URL", transactions: true },
        { name: "old", url: "$OLD_RPC_URL", transactions: true },
        { name: "old-literal", url: `https://api.${RETIRED_RPC_HOSTS[0]}/rpc` },
      ]),
    });
    const endpoints = [...pool.read, ...pool.transaction].map((member) => member.endpoint);
    expect(pool.source).toBe("env");
    expect(endpoints).toEqual(["https://alchemy.example/v2/x", "https://alchemy.example/v2/x"]);
  });

  it("falls back to the legacy pair when only retired providers were listed", () => {
    const pool = resolveRpcPool({
      OLD_RPC_URL: RETIRED,
      SOLANA_RPC_URL: "https://helius.example/rpc",
      SOLANA_RPC_PROVIDERS: JSON.stringify([{ name: "old", url: "$OLD_RPC_URL", transactions: true }]),
    });
    const endpoints = [...pool.read, ...pool.transaction].map((member) => member.endpoint);
    expect(endpoints.some((endpoint) => isRetiredRpcEndpoint(endpoint))).toBe(false);
    expect(endpoints).toContain("https://helius.example/rpc");
  });
});

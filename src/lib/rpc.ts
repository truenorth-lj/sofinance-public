import "server-only";

import { Connection } from "@solana/web3.js";

/** Public Solana mainnet RPC used only when no dedicated endpoint is configured. */
export const PUBLIC_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";

/** Solami HTTP JSON-RPC. Auth is `?api_key=` (never a header). */
export const SOLAMI_RPC_BASE_URL = "https://rpc.solami.dev/sol";

export type RpcProvider = "solami" | "default";

export type RpcConfig = {
  endpoint: string;
  provider: RpcProvider;
};

export type RpcEnv = Record<string, string | undefined>;

/**
 * Prefer Solami RPC when `SOLAMI_API_KEY` is set, else `SOLANA_RPC_URL`, else
 * the public mainnet endpoint. Keys stay server-side; never log the endpoint.
 */
export function resolveRpcConfig(env: RpcEnv = process.env as RpcEnv): RpcConfig {
  const solamiKey = env.SOLAMI_API_KEY?.trim();
  if (solamiKey) {
    const url = new URL(SOLAMI_RPC_BASE_URL);
    url.searchParams.set("api_key", solamiKey);
    return { endpoint: url.toString(), provider: "solami" };
  }
  const dedicated = env.SOLANA_RPC_URL?.trim();
  if (dedicated) {
    return { endpoint: dedicated, provider: "default" };
  }
  return { endpoint: PUBLIC_SOLANA_RPC_URL, provider: "default" };
}

export function rpcProvider(env: RpcEnv = process.env as RpcEnv): RpcProvider {
  return resolveRpcConfig(env).provider;
}

/**
 * Non-Solami RPC for history fallback: `SOLANA_RPC_URL`, else public mainnet.
 * Used when Solami's history window is empty or a parsed tx fails validation.
 */
export function resolveDefaultRpcConfig(env: RpcEnv = process.env as RpcEnv): RpcConfig {
  const dedicated = env.SOLANA_RPC_URL?.trim();
  if (dedicated) {
    return { endpoint: dedicated, provider: "default" };
  }
  return { endpoint: PUBLIC_SOLANA_RPC_URL, provider: "default" };
}

export function rpcConnection(env: RpcEnv = process.env as RpcEnv) {
  const { endpoint } = resolveRpcConfig(env);
  return new Connection(endpoint, "confirmed");
}

export function defaultRpcConnection(env: RpcEnv = process.env as RpcEnv) {
  return new Connection(resolveDefaultRpcConfig(env).endpoint, "confirmed");
}

/** Strip credential query params so an endpoint can be mentioned in errors. */
export function redactRpcEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (url.searchParams.has("api_key")) url.searchParams.set("api_key", "REDACTED");
    return `${url.origin}${url.pathname}`;
  } catch {
    return "rpc";
  }
}

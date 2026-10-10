import { invokeWithPolicy } from "./connection";
import { RpcHttpError } from "./errors";
import { resolveProviderPair } from "./providers";
import { parseRetryAfter } from "./retry";
import type { RpcEnv } from "./types";

export type RpcRequestOptions = {
  env?: RpcEnv;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
};

async function postJsonRpc(
  endpoint: string,
  method: string,
  params: unknown[],
  options: RpcRequestOptions,
): Promise<unknown> {
  const fetcher = options.fetcher ?? fetch;
  const timeout = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
  const signals = [options.signal, timeout].filter((item): item is AbortSignal => Boolean(item));
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal,
    });
  } catch (error) {
    if (timeout?.aborted) {
      const timed = new Error(`RPC ${method} timed out`);
      timed.name = "TimeoutError";
      throw timed;
    }
    throw error;
  }
  if (!response.ok) {
    throw new RpcHttpError(response.status, `RPC HTTP ${response.status}`, parseRetryAfter(response.headers.get("retry-after")));
  }
  const data: unknown = await response.json();
  if (data && typeof data === "object" && "error" in data) {
    const err = (data as { error?: { code?: number; message?: string } }).error;
    throw new Error(`RPC ${err?.code ?? "error"}: ${err?.message ?? "request failed"}`);
  }
  if (data && typeof data === "object" && "result" in data) {
    return (data as { result: unknown }).result;
  }
  return data;
}

/** Raw JSON-RPC through the same provider / retry / cache / failover layer. */
export async function rpcRequest<T = unknown>(
  method: string,
  params: unknown[] = [],
  options: RpcRequestOptions = {},
): Promise<T> {
  const pair = resolveProviderPair(options.env ?? (process.env as RpcEnv));
  const result = await invokeWithPolicy({
    method,
    args: params,
    signal: options.signal,
    primary: () => postJsonRpc(pair.primary.endpoint, method, params, options),
    fallback: pair.fallback
      ? () => postJsonRpc(pair.fallback!.endpoint, method, params, options)
      : undefined,
    primaryId: pair.primary.metricId,
    fallbackId: pair.fallback?.metricId,
  });
  return result.value as T;
}

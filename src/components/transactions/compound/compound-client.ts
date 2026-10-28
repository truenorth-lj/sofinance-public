import { ApiRequestError } from "@/lib/public-error";

/** A failed API call that also keeps the route's machine-readable code (e.g. `rpc_unavailable`). */
class CompoundApiError extends ApiRequestError {
  readonly code?: string;
  constructor(message: string, sent?: boolean, code?: string) {
    super(message, sent);
    if (code) this.code = code;
  }
}
export function isRpcUnavailable(error: unknown) {
  return error instanceof CompoundApiError && error.code === "rpc_unavailable";
}

export async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), cache: "no-store", signal });
  const value = await response.json() as T & { error?: string; sent?: boolean; code?: string };
  if (!response.ok) {
    throw new CompoundApiError(value.error || "Unable to complete on-chain query, please retry later",
      value.sent === false ? false : undefined, typeof value.code === "string" ? value.code : undefined);
  }
  return value;
}

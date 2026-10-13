import "server-only";
import { getRwaConfig } from "./config/rwa-env";
import { discoverRwaPairs, getCachedRwaPairs } from "./rwa-pairs";
import { fetchPoolRangeApr } from "./pool-range-apr";
import { createRwaDatabase, PostgresRwaStore } from "./rwa-postgres-store";
import {
  RwaStoreError,
  type PairOptions,
  type RwaStore,
  type SnapshotApr,
  type SnapshotPairs,
  type StoreRequest,
} from "./rwa-store-types";

let direct: { url: string; store: PostgresRwaStore } | undefined;
export function getRwaStore(): RwaStore {
  const config = getRwaConfig();
  if (config.gatewayUrl) {
    const base = new URL(config.gatewayUrl);
    if (
      base.username ||
      base.password ||
      base.hash ||
      (base.protocol !== "https:" &&
        !(
          base.protocol === "http:" &&
          !config.isVercel &&
          ["localhost", "127.0.0.1"].includes(base.hostname)
        ))
    ) {
      throw new RwaStoreError("INVALID_GATEWAY_URL");
    }
    if (!config.secret || config.secret.length < 32)
      throw new RwaStoreError("RWA_STORE_UNAVAILABLE");
    return {
      async request(input) {
        try {
          const response = await fetch(new URL("/v1/rwa", base), {
            method: "POST",
            cache: "no-store",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.secret}`,
            },
            body: JSON.stringify(input),
            signal: AbortSignal.timeout(10_000),
          });
          const body = await response.json();
          if (!response.ok)
            throw new RwaStoreError(
              typeof body.code === "string"
                ? body.code
                : "RWA_STORE_UNAVAILABLE",
            );
          return body;
        } catch (error) {
          throw error instanceof RwaStoreError
            ? error
            : new RwaStoreError("RWA_STORE_UNAVAILABLE");
        }
      },
    };
  }
  // Production functions never send PostgreSQL credentials over the existing non-TLS public port.
  if (config.isVercel || !config.databaseUrl)
    throw new RwaStoreError("RWA_STORE_UNAVAILABLE");
  if (!direct || direct.url !== config.databaseUrl)
    direct = {
      url: config.databaseUrl,
      store: new PostgresRwaStore(createRwaDatabase(config.databaseUrl)),
    };
  return direct.store;
}

export async function getRwaPairs(options: PairOptions) {
  if (!getRwaConfig().enabled)
    return (
      getCachedRwaPairs(options.minTvl, options.maxPages, options.sortBy) ??
      discoverRwaPairs(options)
    );
  return (await getRwaStore().request({
    op: "pairs",
    ...options,
  })) as SnapshotPairs;
}
export async function getPoolAprSnapshot(poolId: string) {
  if (!getRwaConfig().enabled) return fetchPoolRangeApr(poolId);
  try {
    return (await getRwaStore().request({ op: "apr", poolId })) as SnapshotApr;
  } catch (error) {
    // This endpoint also serves ordinary CLMM positions. Only pools never in
    // the RWA feed keep that existing path; failed tracked snapshots fail closed.
    if (error instanceof RwaStoreError && error.code === "POOL_NOT_TRACKED")
      return fetchPoolRangeApr(poolId);
    throw error;
  }
}

export function snapshotError(error: unknown) {
  const code =
    error instanceof RwaStoreError ? error.code : "RWA_STORE_UNAVAILABLE";
  return Response.json(
    {
      error:
        "Saved pool data is temporarily unavailable. Please try again shortly.",
      code,
    },
    {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "60" },
    },
  );
}

export async function storeCall<T>(
  store: RwaStore,
  request: StoreRequest,
): Promise<T> {
  return (await store.request(request)) as T;
}

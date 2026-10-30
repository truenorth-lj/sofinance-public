import "server-only";
import { getRwaConfig } from "./config/rwa-env";
import { discoverRwaPairs, getCachedRwaPairs } from "./rwa-pairs";
import { fetchPoolRangeApr } from "./pool-range-apr";
import { PostgresRwaStore } from "./rwa-postgres-store";
import { getRwaDatabase, runRwaDatabaseRequest } from "./rwa-database";
import { tokenIconMap } from "./token-icons/map";
import {
  RwaStoreError,
  type PairOptions,
  type RwaStore,
  type StoreRequest,
  type StoreOperation,
  type StoreResultMap,
} from "./rwa-store-types";

let direct: { db: ReturnType<typeof getRwaDatabase>; store: RwaStore } | undefined;
export function getRwaStore(): RwaStore {
  const config = getRwaConfig();
  if (config.storeMode === "gateway" && config.gatewayUrl) {
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
      async request<K extends StoreOperation>(input: StoreRequest<K>) {
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
          // Trusted internal gateway wire boundary; the service uses the same checked handlers.
          // This annotation is not runtime response-schema validation.
          return body as StoreResultMap[K];
        } catch (error) {
          throw error instanceof RwaStoreError
            ? error
            : new RwaStoreError("RWA_STORE_UNAVAILABLE");
        }
      },
    };
  }
  // Gateway mode preserves the private-network service/local path, never Vercel plaintext PG.
  if ((config.storeMode === "gateway" && config.isVercel) || !config.databaseUrl)
    throw new RwaStoreError("RWA_STORE_UNAVAILABLE");
  try {
    const db = getRwaDatabase();
    if (!direct || direct.db !== db) {
      const store = new PostgresRwaStore(db);
      direct = { db, store: { async request(input) {
        try {
          // A caller may retain this wrapper across pool retirement. Select a
          // fresh pool before starting work; never retry a started operation.
          if (getRwaDatabase() !== db) return await getRwaStore().request(input);
          return await runRwaDatabaseRequest(db, () => store.request(input));
        }
        catch (error) { throw error instanceof RwaStoreError ? error : new RwaStoreError("RWA_STORE_UNAVAILABLE"); }
      } } };
    }
  } catch { throw new RwaStoreError("RWA_STORE_UNAVAILABLE"); }
  return direct.store;
}

export async function getRwaPairs(options: PairOptions) {
  if (!getRwaConfig().enabled)
    return (
      getCachedRwaPairs(options.minTvl, options.maxPages, options.sortBy) ??
      discoverRwaPairs(options)
    );
  const snapshot = await getRwaStore().request({
    op: "pairs",
    ...options,
  });
  // A gateway running an older store build returns no `tokenIcons`; keep the manual list in that case.
  return snapshot.tokenIcons ? snapshot : { ...snapshot, tokenIcons: tokenIconMap([]) };
}
export async function getPoolAprSnapshot(poolId: string) {
  if (!getRwaConfig().enabled) return fetchPoolRangeApr(poolId);
  try {
    return await getRwaStore().request({ op: "apr", poolId });
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

import "server-only";
import type { ZodType } from "zod";
import { getRwaConfig } from "./config/rwa-env";
import { getRwaDatabase, runRwaDatabaseRequest } from "./rwa-database";

type RwaDatabase = ReturnType<typeof getRwaDatabase>;

type StoreError = new (code: string) => Error & { code: string };
type StoreRequest = { request: (input: never) => Promise<unknown> };

const LOCAL_HOSTS = ["localhost", "127.0.0.1"] as const;

export function isAllowedGatewayUrl(base: URL, isVercel: boolean): boolean {
  if (base.username || base.password || base.hash) return false;
  if (base.protocol === "https:") return true;
  return base.protocol === "http:" && !isVercel && LOCAL_HOSTS.includes(base.hostname as (typeof LOCAL_HOSTS)[number]);
}

export type RoutedStoreOptions<TStore extends StoreRequest> = {
  path: string;
  ErrorClass: StoreError;
  unavailableCode: string;
  makePostgres: (db: RwaDatabase) => TStore;
  timeoutMs: number;
  schema?: ZodType;
  /** Reuse the gateway client for the same url+secret (position-history and entry-price). */
  cacheGateway?: boolean;
  /** When set, reject a serialized body larger than this many bytes with `oversizedCode`. */
  maxBodyBytes?: number;
  oversizedCode?: string;
  /** If the Neon pool was retired after this client was built, re-enter the getter (rwa and position-history). */
  refreshDirectIfPoolRetired?: boolean;
};

export function createRoutedStore<TStore extends StoreRequest>(options: RoutedStoreOptions<TStore>): () => TStore {
  let direct: { db: RwaDatabase; store: TStore } | undefined;
  let gateway: { url: string; secret: string; store: TStore } | undefined;
  const fail = (code: string) => new options.ErrorClass(code);
  const unavailable = () => fail(options.unavailableCode);
  const asStoreError = (error: unknown) => (error instanceof options.ErrorClass ? error : unavailable());

  function getStore(): TStore {
    const config = getRwaConfig();
    if (config.storeMode === "gateway" && config.gatewayUrl) {
      const base = new URL(config.gatewayUrl);
      if (!isAllowedGatewayUrl(base, config.isVercel)) throw fail("INVALID_GATEWAY_URL");
      if (!config.secret || config.secret.length < 32) throw unavailable();
      if (options.cacheGateway && gateway?.url === base.href && gateway.secret === config.secret) return gateway.store;
      const secret = config.secret;
      const store = {
        async request(input: unknown) {
          const body = JSON.stringify(options.schema ? options.schema.parse(input) : input);
          if (options.maxBodyBytes !== undefined && Buffer.byteLength(body) > options.maxBodyBytes) {
            throw fail(options.oversizedCode ?? options.unavailableCode);
          }
          try {
            const response = await fetch(new URL(options.path, base), {
              method: "POST",
              cache: "no-store",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
              body,
              signal: AbortSignal.timeout(options.timeoutMs),
            });
            const result = await response.json();
            if (!response.ok) throw fail(typeof result.code === "string" ? result.code : options.unavailableCode);
            return result;
          } catch (error) {
            throw asStoreError(error);
          }
        },
      } as TStore;
      if (options.cacheGateway) gateway = { url: base.href, secret, store };
      return store;
    }
    if ((config.storeMode === "gateway" && config.isVercel) || !config.databaseUrl) throw unavailable();
    try {
      const db = getRwaDatabase();
      if (!direct || direct.db !== db) {
        const postgres = options.makePostgres(db);
        direct = {
          db,
          store: {
            async request(input: unknown) {
              try {
                if (options.refreshDirectIfPoolRetired && getRwaDatabase() !== db) return await getStore().request(input as never);
                return await runRwaDatabaseRequest(db, () => postgres.request(input as never));
              } catch (error) {
                throw asStoreError(error);
              }
            },
          } as TStore,
        };
      }
    } catch (error) {
      throw asStoreError(error);
    }
    return direct.store;
  }

  return getStore;
}

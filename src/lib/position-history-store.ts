import "server-only";
import { getRwaConfig } from "./config/rwa-env";
import { getRwaDatabase } from "./rwa-database";
import { PostgresPositionHistoryStore } from "./position-history-postgres-store";
import { PositionHistoryStoreError, positionStoreRequestSchema, type PositionHistoryStore } from "./position-history-store-types";

let direct: { db: ReturnType<typeof getRwaDatabase>; store: PositionHistoryStore } | undefined;
let gateway: { url: string; secret: string; store: PositionHistoryStore } | undefined;

/** The existing HTTPS gateway keeps database credentials on its private network. */
export function getPositionHistoryStore(): PositionHistoryStore {
  const config = getRwaConfig();
  if (config.storeMode === "gateway" && config.gatewayUrl) {
    const base = new URL(config.gatewayUrl);
    if (base.username || base.password || base.hash ||
      (base.protocol !== "https:" && !(base.protocol === "http:" && !config.isVercel &&
        ["localhost", "127.0.0.1"].includes(base.hostname)))) {
      throw new PositionHistoryStoreError("INVALID_GATEWAY_URL");
    }
    if (!config.secret || config.secret.length < 32) throw new PositionHistoryStoreError("POSITION_STORE_UNAVAILABLE");
    if (gateway?.url === base.href && gateway.secret === config.secret) return gateway.store;
    const store: PositionHistoryStore = {
      async request(input) {
        const body = JSON.stringify(positionStoreRequestSchema.parse(input));
        if (Buffer.byteLength(body) > 16_000_000) throw new PositionHistoryStoreError("POSITION_HISTORY_BATCH_TOO_LARGE");
        try {
          const response = await fetch(new URL("/v1/position-history", base), {
            method: "POST", cache: "no-store",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.secret}` },
            body, signal: AbortSignal.timeout(10_000),
          });
          const result = await response.json();
          if (!response.ok) throw new PositionHistoryStoreError(
            typeof result.code === "string" ? result.code : "POSITION_STORE_UNAVAILABLE");
          return result;
        } catch (error) {
          throw error instanceof PositionHistoryStoreError ? error : new PositionHistoryStoreError("POSITION_STORE_UNAVAILABLE");
        }
      },
    };
    gateway = { url: base.href, secret: config.secret, store };
    return store;
  }
  if ((config.storeMode === "gateway" && config.isVercel) || !config.databaseUrl)
    throw new PositionHistoryStoreError("POSITION_STORE_UNAVAILABLE");
  try {
    const db = getRwaDatabase();
    if (!direct || direct.db !== db) {
      const store = new PostgresPositionHistoryStore(db);
      direct = { db, store: { async request(input) {
        try { return await store.request(input); }
        catch (error) { throw error instanceof PositionHistoryStoreError ? error : new PositionHistoryStoreError("POSITION_STORE_UNAVAILABLE"); }
      } } };
    }
  } catch { throw new PositionHistoryStoreError("POSITION_STORE_UNAVAILABLE"); }
  return direct.store;
}

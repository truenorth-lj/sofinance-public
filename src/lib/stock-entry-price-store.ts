import "server-only";
import { getRwaConfig } from "./config/rwa-env";
import { getRwaDatabase, runRwaDatabaseRequest } from "./rwa-database";
import { PostgresStockEntryPriceStore } from "./stock-entry-price-postgres-store";
import {
  entryPriceStoreRequestSchema, StockEntryPriceStoreError,
  type EntryPriceStoreOperation, type EntryPriceStoreRequest, type EntryPriceStoreResultMap, type StockEntryPriceStore,
} from "./stock-entry-price-store-types";

let direct: { db: ReturnType<typeof getRwaDatabase>; store: StockEntryPriceStore } | undefined;
let gateway: { url: string; secret: string; store: StockEntryPriceStore } | undefined;

/** Same deployment rules as the position-history store: the HTTPS gateway on Vercel, the database directly elsewhere. */
export function getStockEntryPriceStore(): StockEntryPriceStore {
  const config = getRwaConfig();
  if (config.storeMode === "gateway" && config.gatewayUrl) {
    const base = new URL(config.gatewayUrl);
    if (base.username || base.password || base.hash ||
      (base.protocol !== "https:" && !(base.protocol === "http:" && !config.isVercel && ["localhost", "127.0.0.1"].includes(base.hostname))))
      throw new StockEntryPriceStoreError("INVALID_GATEWAY_URL");
    if (!config.secret || config.secret.length < 32) throw new StockEntryPriceStoreError("ENTRY_PRICE_STORE_UNAVAILABLE");
    if (gateway?.url === base.href && gateway.secret === config.secret) return gateway.store;
    const secret = config.secret;
    const store: StockEntryPriceStore = {
      async request<K extends EntryPriceStoreOperation>(input: EntryPriceStoreRequest<K>) {
        try {
          const response = await fetch(new URL("/v1/entry-prices", base), {
            method: "POST", cache: "no-store",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
            body: JSON.stringify(entryPriceStoreRequestSchema.parse(input)), signal: AbortSignal.timeout(5_000),
          });
          const result = await response.json();
          if (!response.ok) throw new StockEntryPriceStoreError(typeof result.code === "string" ? result.code : "ENTRY_PRICE_STORE_UNAVAILABLE");
          // Trusted internal gateway wire boundary, as for the position-history store.
          return result as EntryPriceStoreResultMap[K];
        } catch (error) {
          throw error instanceof StockEntryPriceStoreError ? error : new StockEntryPriceStoreError("ENTRY_PRICE_STORE_UNAVAILABLE");
        }
      },
    };
    gateway = { url: base.href, secret, store };
    return store;
  }
  if ((config.storeMode === "gateway" && config.isVercel) || !config.databaseUrl)
    throw new StockEntryPriceStoreError("ENTRY_PRICE_STORE_UNAVAILABLE");
  try {
    const db = getRwaDatabase();
    if (!direct || direct.db !== db) {
      const store = new PostgresStockEntryPriceStore(db);
      direct = { db, store: { async request(input) {
        try { return await runRwaDatabaseRequest(db, () => store.request(input)); }
        catch (error) { throw error instanceof StockEntryPriceStoreError ? error : new StockEntryPriceStoreError("ENTRY_PRICE_STORE_UNAVAILABLE"); }
      } } };
    }
  } catch { throw new StockEntryPriceStoreError("ENTRY_PRICE_STORE_UNAVAILABLE"); }
  return direct.store;
}

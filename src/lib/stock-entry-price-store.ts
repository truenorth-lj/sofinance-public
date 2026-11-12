import "server-only";
import { PostgresStockEntryPriceStore } from "./stock-entry-price-postgres-store";
import {
  entryPriceStoreRequestSchema, StockEntryPriceStoreError, type StockEntryPriceStore,
} from "./stock-entry-price-store-types";
import { createRoutedStore } from "./routed-store";

/** Same deployment rules as the position-history store: the HTTPS gateway on Vercel, the database directly elsewhere. */
export const getStockEntryPriceStore = createRoutedStore<StockEntryPriceStore>({
  path: "/v1/entry-prices",
  ErrorClass: StockEntryPriceStoreError,
  unavailableCode: "ENTRY_PRICE_STORE_UNAVAILABLE",
  makePostgres: (db) => new PostgresStockEntryPriceStore(db),
  timeoutMs: 5_000,
  schema: entryPriceStoreRequestSchema,
  cacheGateway: true,
});

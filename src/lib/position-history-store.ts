import "server-only";
import { PostgresPositionHistoryStore } from "./position-history-postgres-store";
import {
  PositionHistoryStoreError, positionStoreRequestSchema, type PositionHistoryStore,
} from "./position-history-store-types";
import { createRoutedStore } from "./routed-store";

/** The existing HTTPS gateway keeps database credentials on its private network. */
export const getPositionHistoryStore = createRoutedStore<PositionHistoryStore>({
  path: "/v1/position-history",
  ErrorClass: PositionHistoryStoreError,
  unavailableCode: "POSITION_STORE_UNAVAILABLE",
  makePostgres: (db) => new PostgresPositionHistoryStore(db),
  timeoutMs: 10_000,
  schema: positionStoreRequestSchema,
  cacheGateway: true,
  maxBodyBytes: 16_000_000,
  oversizedCode: "POSITION_HISTORY_BATCH_TOO_LARGE",
  refreshDirectIfPoolRetired: true,
});

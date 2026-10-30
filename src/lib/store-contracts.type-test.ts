/** Compile-only contract checks. Included by app tsc; never invoked at runtime. */
import { expectTypeOf } from "vitest";
import type { PostgresRwaStore } from "./rwa-postgres-store";
import type { PostgresPositionHistoryStore } from "./position-history-postgres-store";
import type { RwaStore, StoreRequest, StoreResultMap, StoreHandlers, SnapshotPairs, Lease, ActivePool } from "./rwa-store-types";
import type { PositionHistoryStore, PositionStoreRequest, PositionStoreResultMap, PositionStoreHandlers,
  PositionHistorySnapshot, PositionHistoryLease } from "./position-history-store-types";

export function checkStoreContracts(rwa: RwaStore, postgres: PostgresRwaStore, position: PositionHistoryStore,
  positionPostgres: PostgresPositionHistoryStore, lease: PositionHistoryLease, dynamic: StoreRequest) {
  expectTypeOf<keyof StoreResultMap>().toEqualTypeOf<StoreRequest["op"]>();
  expectTypeOf<keyof PositionStoreResultMap>().toEqualTypeOf<PositionStoreRequest["op"]>();
  const pairs = rwa.request({ op: "pairs", minTvl: 0, maxPages: 1, sortBy: "tvl" });
  expectTypeOf(pairs).toEqualTypeOf<Promise<SnapshotPairs>>();
  expectTypeOf(rwa.request({ op: "claim", job: "rwa-discovery" })).toEqualTypeOf<Promise<Lease | null>>();
  expectTypeOf(postgres.request({ op: "activePools" })).toEqualTypeOf<Promise<ActivePool[]>>();
  expectTypeOf(rwa.request(dynamic)).toEqualTypeOf<Promise<StoreResultMap[StoreRequest["op"]]>>();
  const release = position.request({ op: "release", lease });
  expectTypeOf(release).toEqualTypeOf<Promise<boolean>>();
  expectTypeOf(positionPostgres.request({ op: "release", lease })).toEqualTypeOf<Promise<boolean>>();
  // @ts-expect-error A caller cannot choose a response type unrelated to the operation.
  expectTypeOf(pairs).toEqualTypeOf<Promise<boolean>>();
  // @ts-expect-error Release is a boolean, never a history snapshot.
  expectTypeOf(release).toEqualTypeOf<Promise<PositionHistorySnapshot>>();
  // @ts-expect-error An APR read requires its pool identifier.
  rwa.request({ op: "apr" });
  // @ts-expect-error Store implementations must return the operation's result, not any member of the union.
  const invalidRwaHandler: StoreHandlers["pairs"] = async () => true;
  // @ts-expect-error Position release implementations cannot return a missing snapshot/null.
  const invalidPositionHandler: PositionStoreHandlers["release"] = async () => null;
  return { invalidRwaHandler, invalidPositionHandler };
}

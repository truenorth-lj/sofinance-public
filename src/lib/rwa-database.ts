import "server-only";
import postgres from "postgres";
import { rwaConnectionTarget } from "../db/connection";
import type { RwaDatabaseRole } from "../db/target";
import { getRwaConfig } from "./config/rwa-env";

const expectedRoles = new WeakMap<postgres.Sql, RwaDatabaseRole>();
const identities = new WeakMap<postgres.Sql, Promise<void>>();

/** Direct sessions only: startup settings cover non-transaction reads as well as writes. PG17+. */
export function createRwaDatabase(url: string, schemaName = "public") {
  if (!/^[a-z_][a-z0-9_]*$/.test(schemaName)) throw new Error("Invalid database schema");
  const config = getRwaConfig();
  const target = rwaConnectionTarget(url, config.expectedRole, config.storeMode === "neon" || config.isVercel);
  const db = postgres(target.url, {
    ssl: target.ssl,
    max: config.poolMax, connect_timeout: config.connectTimeoutMs / 1000,
    idle_timeout: 20, max_lifetime: 600, prepare: false,
    connection: { options: `-c search_path=${schemaName} -c statement_timeout=${config.queryTimeoutMs} -c lock_timeout=3000 -c transaction_timeout=8000` },
    onnotice: () => {}, debug: false,
  });
  expectedRoles.set(db, config.expectedRole);
  return db;
}

/** Check the SQL identity before business reads/writes. Transient failures may retry next request. */
export async function assertRwaDatabaseIdentity(db: postgres.Sql) {
  let checked = identities.get(db);
  if (!checked) {
    checked = (async () => {
      const expectedRole = expectedRoles.get(db) ?? getRwaConfig().expectedRole;
      const [target] = await db`SELECT current_database() AS database,current_user AS role,current_setting('server_version_num')::integer AS version`;
      if (target?.database !== "sofinance" || target.role !== expectedRole || target.version < 170000)
        throw new Error("RWA database identity or PostgreSQL version mismatch");
    })();
    identities.set(db, checked);
  }
  try { await checked; }
  catch { identities.delete(db); throw new Error("RWA database identity check failed"); }
}

let runtime: { key: string; db: postgres.Sql } | undefined;
/** One pool per process for BOTH stores. Opens, when configured, remains a separate explicit store. */
export function getRwaDatabase() {
  const config = getRwaConfig();
  if (!config.databaseUrl) throw new Error("RWA database is unavailable");
  // Validate on every selection, including cache hits; no gateway/insecure fallback on Neon failure.
  rwaConnectionTarget(config.databaseUrl, config.expectedRole, config.storeMode === "neon" || config.isVercel);
  const key = JSON.stringify([config.databaseUrl, config.storeMode, config.expectedRole, config.isVercel,
    config.poolMax, config.connectTimeoutMs, config.queryTimeoutMs]);
  if (!runtime || runtime.key !== key) {
    const previous = runtime;
    runtime = { key, db: createRwaDatabase(config.databaseUrl) };
    // Config is immutable in deployed functions; close a replaced pool during local config changes.
    if (previous) void previous.db.end({ timeout: 5 }).catch(() => {});
  }
  return runtime.db;
}

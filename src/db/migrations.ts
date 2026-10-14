import { randomUUID } from "node:crypto";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type postgres from "postgres";

export const rwaTables = ["background_job_state", "rwa_apr_daily", "rwa_apr_latest", "rwa_feed_state", "rwa_pool_latest"];
const identifier = (value: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error("Invalid migration schema");
  return value;
};
const migrationSchema = (schema: string) => schema === "public" ? "drizzle" : `${schema}_drizzle`;
const lockKey = 763240911;

/** Structural comparison uses PostgreSQL's own parsed/deparsed DDL, not text guesses. */
async function signature(db: postgres.Sql, schema: string) {
  const normalize = (value: unknown) => typeof value === "string"
    ? value.replaceAll(`"${schema}".`, "").replaceAll(`${schema}.`, "") : value;
  const columns = await db`
    SELECT c.relname AS table_name,a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,
      a.attnotnull AS not_null,pg_get_expr(d.adbin,d.adrelid) AS default_value
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname=${schema} AND c.relname IN ${db(rwaTables)} ORDER BY c.relname,a.attnum`;
  const constraints = await db`
    SELECT c.relname AS table_name,k.conname AS name,k.contype AS type,
      pg_get_constraintdef(k.oid) AS definition,k.convalidated AS validated
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=${schema} AND c.relname IN ${db(rwaTables)} ORDER BY c.relname,k.conname`;
  const indexes = await db`
    SELECT c.relname AS table_name,i.relname AS name,pg_get_indexdef(i.oid) AS definition,
      x.indisvalid AS valid,x.indisready AS ready
    FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=${schema} AND c.relname IN ${db(rwaTables)} ORDER BY c.relname,i.relname`;
  return JSON.stringify({ columns, constraints, indexes }, (_key, value) => normalize(value));
}

async function tableCount(db: postgres.Sql, schema: string) {
  const [row] = await db`SELECT count(*)::int AS count FROM pg_tables WHERE schemaname=${schema} AND tablename IN ${db(rwaTables)}`;
  return Number(row!.count);
}

/** Re-create the initial generated migration only in a disposable schema, then compare. */
async function verifyBaseline(db: postgres.Sql, schema: string, folder: string) {
  const baseline = readMigrationFiles({ migrationsFolder: folder })[0];
  if (!baseline) throw new Error("Missing initial migration");
  const scratch = `rwa_baseline_${randomUUID().replaceAll("-", "")}`;
  await db.unsafe(`CREATE SCHEMA "${scratch}"`);
  try {
    await db.unsafe(`SET LOCAL search_path="${scratch}"`);
    for (const statement of baseline.sql) {
      await db.unsafe(statement.replaceAll('"public".', `"${scratch}".`));
    }
    // Render all catalog definitions in the same search_path so FK names normalize identically.
    await db.unsafe("SET LOCAL search_path=pg_catalog");
    if (await signature(db, schema) !== await signature(db, scratch)) throw new Error("RWA_SCHEMA_DRIFT: existing tables do not match the initial migration");
  } finally {
    await db.unsafe(`DROP SCHEMA "${scratch}" CASCADE`);
    await db.unsafe(`SET LOCAL search_path="${schema}"`);
  }
  return baseline;
}

async function ledger(db: postgres.Sql, schema: string) {
  const name = `${identifier(migrationSchema(schema))}.__drizzle_migrations`;
  const [exists] = await db`SELECT to_regclass(${name}) IS NOT NULL AS present`;
  if (!exists!.present) return [];
  return db.unsafe<{ hash: string; created_at: string }[]>(`SELECT hash,created_at FROM ${name} ORDER BY created_at`);
}

function checkLedger(rows: { hash: string; created_at: string }[], folder: string) {
  const files = readMigrationFiles({ migrationsFolder: folder });
  // Official migrator uses timestamp ordering; add checksum/prefix validation before it skips anything.
  if (rows.length > files.length || rows.some((row, i) => row.hash !== files[i]?.hash || Number(row.created_at) !== files[i]?.folderMillis))
    throw new Error("MIGRATION_LEDGER_MISMATCH: unknown or edited migration");
}

/** A reserved session holds the advisory lock while a second connection runs transactions. */
export async function runRwaMigrations(client: postgres.Sql, mode: "baseline" | "migrate", folder: string, schema = "public") {
  identifier(schema);
  if (client.options.max < 2) throw new Error("Migration pool requires two connections");
  const connection = await client.reserve();
  let locked = false;
  try {
    const [target] = await connection`SELECT current_database() AS database,current_user AS role`;
    if (target!.database !== "sofinance" || target!.role !== "sofinance") throw new Error("Use the dedicated sofinance database and role");
    const [lock] = await connection`SELECT pg_try_advisory_lock(${lockKey}) AS acquired`;
    if (!lock!.acquired) throw new Error("Another RWA migration is running");
    locked = true;
    const rows = await ledger(connection, schema);
    checkLedger(rows, folder);
    const count = await tableCount(connection, schema);
    if (mode === "baseline") {
      if (rows.length > 1) throw new Error("Baseline is only for the initial existing schema");
      if (count !== rwaTables.length) throw new Error("Baseline requires all five existing RWA tables");
      await client.begin(async (tx) => {
        const baseline = await verifyBaseline(tx, schema, folder);
        if (!rows.length) {
          const name = identifier(migrationSchema(schema));
          await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS "${name}"`);
          // The ledger matches the official postgres-js Drizzle migrator layout.
          await tx.unsafe(`CREATE TABLE "${name}".__drizzle_migrations (id SERIAL PRIMARY KEY,hash text NOT NULL,created_at bigint)`);
          await tx.unsafe(`INSERT INTO "${name}".__drizzle_migrations(hash,created_at) VALUES($1,$2)`, [baseline.hash, baseline.folderMillis]);
        }
      });
      return { mode, adopted: !rows.length, applied: 0 };
    }
    if (!rows.length && count) throw new Error("Existing RWA tables require db:baseline before db:migrate");
    // Production migrations use the supported migrator with the committed SQL/journal.
    // Tests rewrite only FK schema references to their disposable schema.
    if (schema !== "public") throw new Error("Use baseline in disposable schemas; migration runner targets public");
    await migrate(drizzle(client), { migrationsFolder: folder, migrationsSchema: migrationSchema(schema) });
    return { mode, adopted: false, applied: readMigrationFiles({ migrationsFolder: folder }).length - rows.length };
  } finally {
    if (locked) await connection`SELECT pg_advisory_unlock(${lockKey})`;
    connection.release();
  }
}

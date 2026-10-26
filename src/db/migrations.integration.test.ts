import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { runRwaMigrations } from "./migrations";
import { rwaConnectionTarget } from "./connection";
import { getRwaExpectedRole } from "../lib/config/rwa-database-env";

const url = process.env.RWA_DB_TEST_URL;
const target = url ? rwaConnectionTarget(url, getRwaExpectedRole()) : null;
describe.skipIf(!url)("Drizzle adoption preserves existing snapshots", () => {
  const schema = `rwa_mig_it_${randomUUID().replaceAll("-", "")}`;
  const folder = resolve("drizzle");
  const temporary = mkdtempSync(resolve(tmpdir(), "rwa-drizzle-test-"));
  const db = target ? postgres(target.url, { ssl: target.ssl, max: 2, prepare: false,
    onnotice: () => {}, connection: { options: `-c search_path=${schema} -c statement_timeout=30000 -c lock_timeout=5000` } }) : null;
  beforeAll(async () => {
    await db!.unsafe(`CREATE SCHEMA "${schema}"`);
    mkdirSync(resolve(temporary, "meta"));
    writeFileSync(resolve(temporary, "meta/_journal.json"), readFileSync(resolve(folder, "meta/_journal.json")));
    const journal = JSON.parse(readFileSync(resolve(folder, "meta/_journal.json"), "utf8"));
    for (const entry of journal.entries) {
      const filename = `${entry.tag}.sql`;
      writeFileSync(resolve(temporary, filename), readFileSync(resolve(folder, filename), "utf8").replaceAll('"public".', `"${schema}".`));
    }
    await migrate(drizzle(db!), { migrationsFolder: temporary, migrationsSchema: `${schema}_fresh` });
    await migrate(drizzle(db!), { migrationsFolder: temporary, migrationsSchema: `${schema}_fresh` });
    const fresh = await db!.unsafe(`SELECT hash FROM "${schema}_fresh".__drizzle_migrations`);
    expect(fresh).toHaveLength(readMigrationFiles({ migrationsFolder: folder }).length);
    await db!`INSERT INTO rwa_feed_state(feed_key,pairing_rule_version,summary) VALUES('retained','v1','{"retained":true}'::jsonb)`;
  }, 30_000);
  afterAll(async () => {
    if (db) {
      await db.unsafe(`DROP SCHEMA IF EXISTS "${schema}_fresh" CASCADE`);
      await db.unsafe(`DROP SCHEMA IF EXISTS "${schema}_drizzle" CASCADE`);
      await db.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.end();
      rmSync(temporary, { recursive: true });
    }
  }, 30_000);
  it("holds the migration lock on its reserved direct session and refuses a competing runner", async () => {
    const owner = await db!.reserve();
    try {
      await owner`SELECT pg_advisory_lock(763240911)`;
      await expect(runRwaMigrations(db!, "baseline", folder, schema)).rejects.toThrow("Another RWA migration is running");
    } finally { await owner`SELECT pg_advisory_unlock(763240911)`; owner.release(); }
  });
  it("refuses migration over an unregistered existing schema", async () => {
    await expect(runRwaMigrations(db!, "migrate", folder, schema)).rejects.toThrow("db:baseline");
  });
  it("verifies the schema, adopts once and preserves business rows", async () => {
    const before = await db!`SELECT * FROM rwa_feed_state`;
    expect(await runRwaMigrations(db!, "baseline", folder, schema)).toEqual({ mode: "baseline", adopted: true, applied: 0 });
    expect(await db!`SELECT * FROM rwa_feed_state`).toEqual(before);
    expect(await runRwaMigrations(db!, "baseline", folder, schema)).toEqual({ mode: "baseline", adopted: false, applied: 0 });
    const rows = await db!.unsafe(`SELECT hash,created_at FROM "${schema}_drizzle".__drizzle_migrations`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hash).toBe(readMigrationFiles({ migrationsFolder: folder })[0]!.hash);
  }, 30_000);
  it("refuses drift and edited migration ledgers", async () => {
    await db!.unsafe(`ALTER TABLE "${schema}".rwa_feed_state ADD COLUMN drift text`);
    await expect(runRwaMigrations(db!, "baseline", folder, schema)).rejects.toThrow("RWA_SCHEMA_DRIFT");
    await db!.unsafe(`ALTER TABLE "${schema}".rwa_feed_state DROP COLUMN drift`);
    await db!.unsafe(`UPDATE "${schema}_drizzle".__drizzle_migrations SET hash='edited'`);
    await expect(runRwaMigrations(db!, "baseline", folder, schema)).rejects.toThrow("MIGRATION_LEDGER_MISMATCH");
  }, 30_000);
});

describe.skipIf(!url)("Additive position migration on the adopted five-table schema", () => {
  const schema = `rwa_add_it_${randomUUID().replaceAll("-", "")}`;
  const folder = resolve("drizzle");
  const temporary = mkdtempSync(resolve(tmpdir(), "rwa-additive-test-"));
  const db = target ? postgres(target.url, { ssl: target.ssl, max: 2, prepare: false, onnotice: () => {},
    connection: { options: `-c search_path=${schema} -c statement_timeout=30000 -c lock_timeout=5000` } }) : null;
  beforeAll(async () => {
    await db!.unsafe(`CREATE SCHEMA "${schema}"`);
    const baseline = readMigrationFiles({ migrationsFolder: folder })[0]!;
    for (const statement of baseline.sql) await db!.unsafe(statement.replaceAll('"public".', `"${schema}".`));
    await db!`INSERT INTO rwa_feed_state(feed_key,pairing_rule_version,summary) VALUES('retained','v1','{"retained":true}'::jsonb)`;
    mkdirSync(resolve(temporary, "meta"));
    const journal = JSON.parse(readFileSync(resolve(folder, "meta/_journal.json"), "utf8"));
    writeFileSync(resolve(temporary, "meta/_journal.json"), JSON.stringify(journal));
    for (const entry of journal.entries) writeFileSync(resolve(temporary, `${entry.tag}.sql`),
      readFileSync(resolve(folder, `${entry.tag}.sql`), "utf8").replaceAll('"public".', `"${schema}".`));
  }, 30_000);
  afterAll(async () => {
    if (db) {
      await db.unsafe(`DROP SCHEMA IF EXISTS "${schema}_drizzle" CASCADE`);
      await db.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.end();
    }
    rmSync(temporary, { recursive: true });
  }, 30_000);
  it("applies and repeats the new migration while preserving prior business rows", async () => {
    const before = await db!`SELECT * FROM rwa_feed_state`;
    await runRwaMigrations(db!, "baseline", folder, schema);
    await migrate(drizzle(db!), { migrationsFolder: temporary, migrationsSchema: `${schema}_drizzle` });
    await migrate(drizzle(db!), { migrationsFolder: temporary, migrationsSchema: `${schema}_drizzle` });
    expect(await db!`SELECT * FROM rwa_feed_state`).toEqual(before);
    const ledger = await db!.unsafe(`SELECT hash FROM "${schema}_drizzle".__drizzle_migrations`);
    expect(ledger).toHaveLength(readMigrationFiles({ migrationsFolder: folder }).length);
    const tables = await db!`SELECT tablename FROM pg_tables WHERE schemaname=${schema} AND tablename LIKE 'position_history_%' ORDER BY tablename`;
    expect(tables.map((row) => row.tablename)).toEqual(["position_history_state", "position_history_transactions"]);
  }, 30_000);
});

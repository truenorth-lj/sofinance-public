/** Only the explicit test URL is used; every case owns disposable schemas. */
import { randomUUID } from "node:crypto";
import { readFileSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import postgres from "postgres";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runOpensMigrations } from "./opens-migrations";
import { opensMigrationTarget } from "./opens-migration-target";

const url = process.env.OPENS_DB_TEST_URL;
const target = url ? opensMigrationTarget(url, url) : null;
const folder = resolve("drizzle-opens");
for (const existing of [false, true]) describe.skipIf(!url)(`opens migrations (${existing ? "legacy adoption" : "fresh database"})`, () => {
  const schema = `opens_it_${randomUUID().replaceAll("-", "")}`;
  const db = target ? postgres(target.url, { ssl: target.ssl, max: 2, prepare: false, onnotice: () => {},
    connection: { options: `-c search_path=${schema} -c statement_timeout=30000 -c lock_timeout=5000` } }) : null;
  const run = (mode: "baseline" | "migrate", source = folder) => runOpensMigrations(db!, mode, source, target!.expected, schema);
  beforeAll(async () => {
    await db!.unsafe(`CREATE SCHEMA "${schema}"`);
    if (existing) {
      await db!.unsafe(readFileSync(resolve("src/db/opens-legacy.fixture.sql"), "utf8"));
      await db!`INSERT INTO sofinance_position_opens(tx_signature,wallet,pool_address,notional_usd,source_ref)
        VALUES('retained-signature','retained-wallet','retained-pool',12.345678,'retained-ref')`;
    }
  });
  afterAll(async () => {
    if (!db) return;
    await db.unsafe(`DROP SCHEMA IF EXISTS "${schema}_opens_drizzle" CASCADE`);
    await db.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.end();
  });
  it("refuses the wrong database identity before schema changes", async () => {
    await expect(runOpensMigrations(db!, "migrate", folder, { ...target!.expected, database: "wrong" }, schema)).rejects.toThrow("identity mismatch");
  });
  it("refuses a competing migration under its reserved session lock", async () => {
    const owner = await db!.reserve();
    try {
      await owner`SELECT pg_advisory_lock(763240912)`;
      // The competing attempt uses a second reserved connection from this max=2 pool.
      await expect(run("migrate")).rejects.toThrow("Another opens migration");
    } finally { await owner`SELECT pg_advisory_unlock(763240912)`; owner.release(); }
  });
  it("adopts or creates once and preserves rows across repeated migration", async () => {
    if (existing) {
      const before = await db!`SELECT row_to_json(o)::text AS data FROM sofinance_position_opens o ORDER BY tx_signature`;
      await expect(run("migrate")).rejects.toThrow("db:opens:baseline");
      expect(await run("baseline")).toEqual({ mode: "baseline", adopted: true, applied: 0 });
      expect(await run("baseline")).toEqual({ mode: "baseline", adopted: false, applied: 0 });
      expect(await db!`SELECT row_to_json(o)::text AS data FROM sofinance_position_opens o ORDER BY tx_signature`).toEqual(before);
    } else {
      expect(await run("migrate")).toEqual({ mode: "migrate", adopted: false, applied: 1 });
      await db!`INSERT INTO sofinance_position_opens(tx_signature,wallet,pool_address) VALUES('retained-signature','retained-wallet','retained-pool')`;
    }
    const before = await db!`SELECT row_to_json(o)::text AS data FROM sofinance_position_opens o ORDER BY tx_signature`;
    expect(await run("migrate")).toEqual({ mode: "migrate", adopted: false, applied: 0 });
    expect(await db!`SELECT row_to_json(o)::text AS data FROM sofinance_position_opens o ORDER BY tx_signature`).toEqual(before);
    const rows = await db!.unsafe(`SELECT hash FROM "${schema}_opens_drizzle".__drizzle_migrations`);
    expect(rows.map(row => row.hash)).toEqual(readMigrationFiles({ migrationsFolder: folder }).map(file => file.hash));
  });
  it("rejects schema drift without changing the stored row", async () => {
    const before = await db!`SELECT row_to_json(o)::text AS data FROM sofinance_position_opens o ORDER BY tx_signature`;
    await db!.unsafe('ALTER TABLE sofinance_position_opens ADD COLUMN drift text');
    await expect(run("baseline")).rejects.toThrow("OPENS_SCHEMA_DRIFT");
    await db!.unsafe('ALTER TABLE sofinance_position_opens DROP COLUMN drift');
    expect(await db!`SELECT row_to_json(o)::text AS data FROM sofinance_position_opens o ORDER BY tx_signature`).toEqual(before);
  });
  it("rejects edited migration files instead of silently skipping them", async () => {
    const temp = mkdtempSync(resolve(tmpdir(), "opens-migration-test-"));
    try {
      cpSync(folder, temp, { recursive: true });
      const { writeFileSync } = await import("node:fs");
      const filename = resolve(temp, "0000_opens-log-baseline.sql");
      writeFileSync(filename, readFileSync(filename, "utf8") + '\n-- edited\n');
      await expect(run("migrate", temp)).rejects.toThrow("MIGRATION_LEDGER_MISMATCH");
    } finally { rmSync(temp, { recursive: true }); }
  });
});

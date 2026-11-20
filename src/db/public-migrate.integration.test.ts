/** Production migrate path: advisory lock, drizzle ledger, committed SQL, public schema. */
import { resolve } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { runRwaMigrations } from "./migrations";
import { rwaConnectionTarget } from "./connection";
import { getRwaExpectedRole } from "../lib/config/rwa-database-env";

const url = process.env.RWA_DB_TEST_URL;
const target = url ? rwaConnectionTarget(url, getRwaExpectedRole()) : null;
describe.skipIf(!url)("runRwaMigrations migrate applies public and is idempotent", () => {
  const folder = resolve("drizzle");
  const db = target ? postgres(target.url, { ssl: target.ssl, max: 2, prepare: false, connect_timeout: 5,
    onnotice: () => {}, connection: { options: "-c search_path=public -c statement_timeout=30000 -c lock_timeout=5000" } }) : null;
  afterAll(async () => { await db?.end(); }, 30_000);

  it("applies committed migrations to public, then applies nothing on the second run", async () => {
    const files = readMigrationFiles({ migrationsFolder: folder });
    const [ledger] = await db!`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`;
    const before = ledger!.present
      ? Number((await db!`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`)[0]!.count) : 0;
    const first = await runRwaMigrations(db!, "migrate", folder, "public");
    expect(first).toEqual({ mode: "migrate", adopted: false, applied: files.length - before });
    const applied = await db!`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at`;
    expect(applied.map((row) => row.hash)).toEqual(files.map((file) => file.hash));
    const [entryPrices] = await db!`SELECT to_regclass('public.position_entry_prices') IS NOT NULL AS present`;
    expect(entryPrices!.present).toBe(true);
    const second = await runRwaMigrations(db!, "migrate", folder, "public");
    expect(second).toEqual({ mode: "migrate", adopted: false, applied: 0 });
    expect(await db!`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at`).toEqual(applied);
  }, 60_000);
});

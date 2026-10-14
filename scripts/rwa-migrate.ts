import postgres from "postgres";
import { resolve } from "node:path";
import { runRwaMigrations } from "../src/db/migrations";
import { getRwaMigrationUrl } from "../src/lib/config/rwa-migration-env";

async function main() {
  const mode = process.argv[2];
  if (mode !== "baseline" && mode !== "migrate") throw new Error("Choose baseline or migrate");
  const db = postgres(getRwaMigrationUrl(), { max: 2, prepare: false, connect_timeout: 5,
    connection: { options: "-c search_path=public -c statement_timeout=30000 -c lock_timeout=5000" }, onnotice: () => {} });
  try { console.log(JSON.stringify(await runRwaMigrations(db, mode, resolve("drizzle")))); }
  finally { await db.end(); }
}
main().catch((error: unknown) => {
  // PostgreSQL errors can include parameters. Only our fixed messages are safe to display.
  const safePrefixes = ["RWA_SCHEMA_DRIFT", "MIGRATION_LEDGER_MISMATCH", "Existing RWA tables require",
    "Use the dedicated", "Baseline ", "Another RWA migration", "Missing initial migration",
    "SOFINANCE_RWA_MIGRATION_DATABASE_URL is required", "Choose baseline or migrate"];
  const message = error instanceof Error && safePrefixes.some((prefix) => error.message.startsWith(prefix))
    ? error.message : "Database migration failed; inspect schema and connectivity";
  console.error(message); process.exitCode = 1;
});

import postgres from "postgres";
import { resolve } from "node:path";
import { runOpensMigrations } from "../src/db/opens-migrations";
import { opensMigrationTarget } from "../src/db/opens-migration-target";

async function main() {
  const mode = process.argv[2];
  if (mode !== "baseline" && mode !== "migrate") throw new Error("Choose baseline or migrate");
  const target = opensMigrationTarget(process.env.SOFINANCE_OPENS_MIGRATION_DATABASE_URL, process.env.SOFINANCE_OPENS_DATABASE_URL);
  const db = postgres(target.url, { ssl: target.ssl, max: 2, prepare: false, connect_timeout: 5,
    connection: { options: "-c search_path=public -c statement_timeout=30000 -c lock_timeout=5000" }, onnotice: () => {} });
  try { console.log(JSON.stringify(await runOpensMigrations(db, mode, resolve("drizzle-opens"), target.expected))); }
  finally { await db.end(); }
}
main().catch((error: unknown) => {
  const safePrefixes = ["OPENS_SCHEMA_DRIFT", "MIGRATION_LEDGER_MISMATCH", "Existing opens table", "Baseline ",
    "Another opens migration", "Missing initial migration", "SOFINANCE_OPENS_", "Choose baseline or migrate",
    "Invalid opens", "Use a direct opens", "Opens migration"];
  // Driver errors may contain connection details or row values. Never print them.
  console.error(error instanceof Error && safePrefixes.some(prefix => error.message.startsWith(prefix))
    ? error.message : "Opens migration failed; inspect schema and connectivity");
  process.exitCode = 1;
});

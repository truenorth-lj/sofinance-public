/**
 * Railway cron entry for the RWA refresh (schedule `RWA_REFRESH_CRON`, see docs/deploy/railway.md).
 * Runs with `node scripts/rwa-refresh-cron.ts` (Node 24 type stripping, no dependencies), then exits.
 */
import { runRwaRefreshCron } from "../src/lib/rwa-refresh-trigger.ts";

process.exitCode = await runRwaRefreshCron({
  env: process.env,
  log: (line) => process.stdout.write(`${line}\n`),
});

import { validateRwaTarget } from "../../db/target";

/** CLI only. Never fall back to the request/worker connection by accident. */
export function getRwaMigrationUrl() {
  const url = process.env.SOFINANCE_RWA_MIGRATION_DATABASE_URL;
  if (!url) throw new Error("SOFINANCE_RWA_MIGRATION_DATABASE_URL is required");
  validateRwaTarget(url);
  return url;
}

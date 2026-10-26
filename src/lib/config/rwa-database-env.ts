import { validateRwaRole } from "../../db/target";

/** Shared by server runtime and the migration CLI; this setting contains no credential. */
export function getRwaExpectedRole() {
  return validateRwaRole(process.env.SOFINANCE_RWA_DB_EXPECTED_ROLE || "sofinance");
}

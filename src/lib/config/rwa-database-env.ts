import { validateRwaRole } from "../../db/target";

/** Shared by server runtime and the migration CLI; this setting contains no credential. */
export function getRwaExpectedRole() {
  return validateRwaRole(process.env.SOFINANCE_RWA_DB_EXPECTED_ROLE || "sofinance");
}

/**
 * Optional pinned root CA (PEM, public, not a credential) for a self-signed Railway Postgres reached
 * through its public TCP proxy. When set, that endpoint is verified against this CA only, never the
 * system roots. Escaped "\\n" sequences (single-line env editors) are restored to newlines.
 */
export function getRwaDatabaseCaPem() {
  const raw = process.env.SOFINANCE_RWA_DB_CA_PEM?.trim();
  if (!raw) return undefined;
  const pem = raw.replaceAll("\\n", "\n");
  if (!/^-----BEGIN CERTIFICATE-----\n[\s\S]+\n-----END CERTIFICATE-----$/.test(pem))
    throw new Error("Invalid RWA database CA certificate");
  return pem;
}

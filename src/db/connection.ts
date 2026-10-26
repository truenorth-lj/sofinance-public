import { validateRwaTarget, type RwaDatabaseRole } from "./target";

/** postgres-js forwards URL query parameters into startup settings. Never forward user options. */
export function rwaConnectionTarget(url: string, expectedRole: RwaDatabaseRole, requireNeon = false) {
  validateRwaTarget(url, expectedRole);
  const target = new URL(url);
  // PostgreSQL URLs preserve DNS case; a DNS root dot is equivalent too. Classify
  // the canonical hostname before either the TLS or direct-session decision.
  target.hostname = target.hostname.toLowerCase().replace(/\.$/, "");
  // postgres-js additionally decodes and splits comma-separated hosts. Accept a
  // single literal DNS/IPv4 hostname only; never classify a driver's host list
  // as a private legacy endpoint (including percent-encoded delimiters/dots).
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(target.hostname))
    throw new Error("Invalid RWA database hostname");
  const neon = /^ep-[a-z0-9-]+(?:\.[a-z0-9-]+)*\.neon\.tech$/.test(target.hostname);
  if ((requireNeon && !neon) || target.hostname.split(".")[0]!.endsWith("-pooler") ||
    (neon && target.port && target.port !== "5432"))
    throw new Error("Use a direct Neon endpoint; pooled runtime and migration are not supported");
  const seen = new Set<string>();
  for (const [key, value] of target.searchParams) {
    if (seen.has(key) || !(
      (key === "sslmode" && ["require", "verify-full", "verify-ca"].includes(value)) ||
      (key === "channel_binding" && ["require", "prefer"].includes(value)) ||
      (key === "sslrootcert" && value === "system")
    )) throw new Error("Invalid RWA database connection options");
    seen.add(key);
  }
  // TLS is always CA + hostname verified on Neon, including URLs with sslmode=require.
  // postgres-js uses tls.connect; explicit servername also binds Node's default checkServerIdentity.
  const tlsRequired = neon || seen.has("sslmode") || seen.has("sslrootcert");
  target.search = "";
  return { url: target.href, ssl: tlsRequired ? { rejectUnauthorized: true, servername: target.hostname } : false as const };
}

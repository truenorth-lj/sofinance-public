import { checkServerIdentity, type PeerCertificate } from "node:tls";
import { validateRwaTarget, type RwaDatabaseRole } from "./target";

/** Railway's self-signed Postgres leaf names only localhost and the private domain, never the proxy host. */
const pinnedServerIdentity = (_host: string, cert: PeerCertificate) => checkServerIdentity("localhost", cert);

/**
 * postgres-js forwards URL query parameters into startup settings. Never forward user options.
 * `requireManaged` (Vercel / store mode "neon") admits a direct Neon endpoint, or a Railway TCP proxy
 * endpoint when `pinnedCaPem` is configured: that one is verified against the pinned CA only.
 */
export function rwaConnectionTarget(url: string, expectedRole: RwaDatabaseRole, requireManaged = false, pinnedCaPem?: string) {
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
  const railwayProxy = /^[a-z0-9-]+\.proxy\.rlwy\.net$/.test(target.hostname);
  // The pin applies to the Railway endpoint only; Neon keeps system-root verification.
  const pinned = !!pinnedCaPem && railwayProxy;
  if ((requireManaged && !neon && !pinned) || target.hostname.split(".")[0]!.endsWith("-pooler") ||
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
  // A pinned Railway endpoint always uses TLS: chain verified against that CA alone (no system roots),
  // then the leaf must be the Railway Postgres server certificate (SAN localhost).
  if (pinned) {
    target.search = "";
    return { url: target.href, ssl: { ca: pinnedCaPem, rejectUnauthorized: true, servername: target.hostname, checkServerIdentity: pinnedServerIdentity } };
  }
  const tlsRequired = neon || seen.has("sslmode") || seen.has("sslrootcert");
  target.search = "";
  return { url: target.href, ssl: tlsRequired ? { rejectUnauthorized: true, servername: target.hostname } : false as const };
}

/** CLI-only target checks. Never fall back to RWA DATABASE_URL or runtime credentials. */
function parseTarget(value: string, direct: boolean) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid opens database target"); }
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hash || !url.username ||
    !/^\/[a-zA-Z0-9_-]+$/.test(url.pathname) ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(url.hostname)) throw new Error("Invalid opens database target");
  const neon = /^ep-[a-z0-9-]+(?:\.[a-z0-9-]+)*\.neon\.tech$/.test(url.hostname);
  if (direct && url.hostname.split(".")[0]!.endsWith("-pooler")) throw new Error("Use a direct opens migration endpoint");
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (seen.has(key) || !((key === "sslmode" && ["require", "verify-full", "verify-ca"].includes(value)) ||
      (key === "channel_binding" && ["require", "prefer"].includes(value)) ||
      (key === "sslrootcert" && value === "system"))) throw new Error("Invalid opens connection options");
    seen.add(key);
  }
  const tls = !["localhost", "127.0.0.1"].includes(url.hostname) || seen.has("sslmode");
  url.search = "";
  return { url, neon, ssl: tls ? { rejectUnauthorized: true, servername: url.hostname } : false as const };
}

export function opensMigrationTarget(migrationUrl: string | undefined, runtimeUrl: string | undefined) {
  if (!migrationUrl?.trim()) throw new Error("SOFINANCE_OPENS_MIGRATION_DATABASE_URL is required");
  if (!runtimeUrl?.trim()) throw new Error("SOFINANCE_OPENS_DATABASE_URL is required to verify the migration target");
  const migration = parseTarget(migrationUrl.trim(), true), runtime = parseTarget(runtimeUrl.trim(), false);
  const host = (target: typeof runtime) => target.neon ? target.url.hostname.replace(/-pooler(?=\.)/, "") : target.url.hostname;
  if (host(migration) !== host(runtime) || migration.url.pathname !== runtime.url.pathname ||
    (migration.url.port || "5432") !== (runtime.url.port || "5432")) throw new Error("Opens migration target does not match runtime database");
  return { url: migration.url.href, ssl: migration.ssl,
    expected: { database: migration.url.pathname.slice(1), role: decodeURIComponent(migration.url.username) } };
}

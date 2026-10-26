import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type postgres from "postgres";
import { assertRwaDatabaseIdentity, createRwaDatabase, getRwaDatabase } from "./rwa-database";
import { getRwaMigrationUrl } from "./config/rwa-migration-env";
import { rwaConnectionTarget } from "../db/connection";
const direct = "postgresql://sofinance:dummy@ep-public-test.ap-southeast-1.aws.neon.tech/sofinance";
beforeEach(() => {
  vi.stubEnv("SOFINANCE_RWA_STORE_MODE", "neon");
  vi.stubEnv("SOFINANCE_RWA_DB_EXPECTED_ROLE", undefined);
  vi.stubEnv("DATABASE_URL", direct);
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("SOFINANCE_RWA_DB_POOL_MAX", "3");
  vi.stubEnv("SOFINANCE_RWA_DB_QUERY_TIMEOUT_MS", "5000");
});
afterEach(() => vi.unstubAllEnvs());
describe("bounded shared direct Neon pool", () => {
  it("requires CA and hostname TLS despite sslmode=require, bounds all sessions and disables prepare", async () => {
    const db = createRwaDatabase(`${direct}?sslmode=require&channel_binding=require`);
    expect(db.options.ssl).toMatchObject({ rejectUnauthorized: true, servername: new URL(direct).hostname });
    expect(db.options.prepare).toBe(false);
    expect(db.options.max).toBe(3);
    expect(db.options.connection.options).toBe("-c search_path=public -c statement_timeout=5000 -c lock_timeout=3000 -c transaction_timeout=8000");
    expect(db.options.connection).not.toHaveProperty("channel_binding");
    expect(db.options.connection).not.toHaveProperty("sslmode");
    await db.end();
  });
  it("shares one runtime pool and revalidates after configuration changes", () => {
    const first = getRwaDatabase();
    expect(getRwaDatabase()).toBe(first);
    vi.stubEnv("SOFINANCE_RWA_DB_POOL_MAX", "2");
    expect(getRwaDatabase()).not.toBe(first);
    vi.stubEnv("DATABASE_URL", direct.replace("ep-public-test", "ep-public-test-pooler"));
    expect(() => getRwaDatabase()).toThrow("direct Neon");
  });
  it.each([
    "?sslmode=disable", "?sslmode=prefer", "?ssl=false", "?options=-c%20statement_timeout=0",
    "?search_path=evil", "?host=attacker.invalid", "?sslrootcert=untrusted", "?sslmode=require&sslmode=disable",
  ])("rejects unsafe URL options without echoing URL %s", (query) => {
    expect(() => createRwaDatabase(direct + query)).toThrow("Invalid RWA database connection options");
  });
  it.each([
    direct.replace("ep-public-test", "ep-public-test-pooler"),
    direct.replace(".neon.tech", ".neon.tech.attacker.invalid"),
    direct.replace("sofinance:dummy", "admin:dummy"), direct.replace("/sofinance", "/other"),
    direct + "#secret", direct.replace(".neon.tech", ".neon.tech:1234"),
  ])("refuses pooled or unintended targets", (url) => {
    expect(() => createRwaDatabase(url)).toThrow();
  });
  it("does not permit Vercel legacy plaintext direct PG", () => {
    vi.stubEnv("SOFINANCE_RWA_STORE_MODE", "gateway");
    expect(() => createRwaDatabase("postgres://sofinance:dummy@localhost/sofinance")).toThrow();
  });
  it("preserves non-Vercel private-network gateway service direct PG", async () => {
    vi.stubEnv("SOFINANCE_RWA_STORE_MODE", "gateway");
    vi.stubEnv("VERCEL", "");
    const db = createRwaDatabase("postgres://sofinance:dummy@localhost/sofinance");
    expect(db.options.ssl).toBe(false);
    await db.end();
  });
  it("validates migration direct endpoints separately without runtime fallback", () => {
    vi.stubEnv("SOFINANCE_RWA_MIGRATION_DATABASE_URL", undefined);
    expect(() => getRwaMigrationUrl()).toThrow("is required");
    vi.stubEnv("SOFINANCE_RWA_MIGRATION_DATABASE_URL", direct.replace("ep-public-test", "ep-public-test-pooler"));
    expect(() => getRwaMigrationUrl()).toThrow("direct Neon");
    vi.stubEnv("SOFINANCE_RWA_MIGRATION_DATABASE_URL", direct);
    expect(getRwaMigrationUrl()).toBe(direct);
  });
  it.each([
    "EP-PUBLIC-TEST.AP-SOUTHEAST-1.AWS.NEON.TECH",
    "ep-public-test.ap-southeast-1.aws.neon.tech.",
  ])("keeps equivalent migration DNS spelling on verified TLS: %s", async (hostname) => {
    const url = direct.replace(new URL(direct).hostname, hostname);
    vi.stubEnv("SOFINANCE_RWA_MIGRATION_DATABASE_URL", url);
    const target = rwaConnectionTarget(getRwaMigrationUrl(), "sofinance");
    const { default: postgres } = await import("postgres");
    const db = postgres(target.url, { ssl: target.ssl, prepare: false });
    expect(db.options.host).toEqual([new URL(direct).hostname]);
    expect(db.options.ssl).toEqual({ rejectUnauthorized: true, servername: new URL(direct).hostname });
    await db.end();
  });
  it.each([
    "EP-PUBLIC-TEST-POOLER.AP-SOUTHEAST-1.AWS.NEON.TECH",
    "ep-public-test-PoOlEr.ap-southeast-1.aws.neon.tech.",
  ])("rejects equivalent pooled migration DNS spelling: %s", (hostname) => {
    vi.stubEnv("SOFINANCE_RWA_MIGRATION_DATABASE_URL", direct.replace(new URL(direct).hostname, hostname));
    expect(() => getRwaMigrationUrl()).toThrow("direct Neon");
  });
  it.each([
    "ep-public-test.ap-southeast-1.aws.neon.tech..",
    "ep-public-test.ap-southeast-1.aws.neon.tech,localhost",
    "ep-public-test-pooler.ap-southeast-1.aws.neon.tech%2Clocalhost",
    "ep-public-test.ap-southeast-1.aws.neon%2etech",
  ])("rejects driver-specific hostname expansion in migrations: %s", (hostname) => {
    vi.stubEnv("SOFINANCE_RWA_MIGRATION_DATABASE_URL", direct.replace(new URL(direct).hostname, hostname));
    expect(() => getRwaMigrationUrl()).toThrow("Invalid RWA database hostname");
  });
});


describe("expected SQL identity", () => {
  it.each(["sofinance", "sofinance_owner"])("checks URL and SQL against explicit role %s", async (role) => {
    vi.stubEnv("SOFINANCE_RWA_DB_EXPECTED_ROLE", role);
    const url = direct.replace("sofinance:dummy", `${role}:dummy`);
    const db = createRwaDatabase(url);
    expect(db.options.user).toBe(role);
    await db.end();
    const sql = vi.fn().mockResolvedValue([{ database: "sofinance", role, version: 180000 }]);
    await assertRwaDatabaseIdentity(sql as unknown as postgres.Sql);
    await assertRwaDatabaseIdentity(sql as unknown as postgres.Sql);
    expect(sql).toHaveBeenCalledTimes(1);
    vi.stubEnv("SOFINANCE_RWA_MIGRATION_DATABASE_URL", url);
    expect(getRwaMigrationUrl()).toBe(url);
  });
  it("requires explicit opt-in to the Neon owner role and rejects arbitrary roles", () => {
    expect(() => createRwaDatabase(direct.replace("sofinance:dummy", "sofinance_owner:dummy"))).toThrow();
    vi.stubEnv("SOFINANCE_RWA_DB_EXPECTED_ROLE", "admin");
    expect(() => createRwaDatabase(direct)).toThrow("Invalid expected RWA database role");
  });
  it.each([
    { database: "other", role: "sofinance", version: 180000 },
    { database: "sofinance", role: "sofinance_owner", version: 180000 },
    { database: "sofinance", role: "sofinance", version: 160000 },
  ])("rejects unexpected server identity/version", async (target) => {
    const sql = vi.fn().mockResolvedValue([target]);
    await expect(assertRwaDatabaseIdentity(sql as unknown as postgres.Sql)).rejects.toThrow("identity check failed");
  });
  it("sanitizes connection errors and retries the SQL check on the next request", async () => {
    const sql = vi.fn().mockRejectedValueOnce(new Error("secret URL")).mockResolvedValue([{ database: "sofinance", role: "sofinance", version: 180000 }]);
    await expect(assertRwaDatabaseIdentity(sql as unknown as postgres.Sql)).rejects.toThrow("RWA database identity check failed");
    await expect(assertRwaDatabaseIdentity(sql as unknown as postgres.Sql)).resolves.toBeUndefined();
  });
});

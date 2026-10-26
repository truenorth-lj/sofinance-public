/** Opt-in PG17+ direct-session bounds. Only disposable schemas; never a production test URL. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { assertRwaDatabaseIdentity, createRwaDatabase } from "./rwa-database";

const url = process.env.RWA_DB_TEST_URL;
describe.skipIf(!url)("direct runtime session safety", () => {
  const schema = `rwa_conn_it_${randomUUID().replaceAll("-", "")}`;
  let db: ReturnType<typeof createRwaDatabase>;
  beforeAll(async () => {
    vi.stubEnv("SOFINANCE_RWA_DB_POOL_MAX", "2");
    vi.stubEnv("SOFINANCE_RWA_DB_QUERY_TIMEOUT_MS", "5000");
    db = createRwaDatabase(url!, schema);
    await assertRwaDatabaseIdentity(db);
    await db.unsafe(`CREATE SCHEMA ${schema}`);
    await db`CREATE TABLE timeout_probe (id integer PRIMARY KEY, value integer)`;
    await db`INSERT INTO timeout_probe VALUES (1,0)`;
  });
  afterAll(async () => {
    if (db) { await db.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end({ timeout: 2 }); }
    vi.unstubAllEnvs();
  });
  it("applies startup search_path and bounds on every direct connection including non-transaction reads", async () => {
    const connections = await Promise.all([db.reserve(), db.reserve()]);
    try {
      for (const connection of connections) {
        const [settings] = await connection`SELECT current_schema() AS schema,current_setting('statement_timeout') AS statement,
          current_setting('lock_timeout') AS lock,current_setting('transaction_timeout') AS transaction`;
        expect(settings).toMatchObject({ schema, statement: "5s", lock: "3s", transaction: "8s" });
      }
    } finally { for (const connection of connections) connection.release(); }
  });
  it("cancels a non-transaction read at the configured statement timeout and reuses the session", async () => {
    vi.stubEnv("SOFINANCE_RWA_DB_QUERY_TIMEOUT_MS", "1000");
    const bounded = createRwaDatabase(url!, schema);
    vi.stubEnv("SOFINANCE_RWA_DB_QUERY_TIMEOUT_MS", "5000");
    try {
      await expect(bounded`SELECT pg_sleep(1.5)`).rejects.toMatchObject({ code: "57014" });
      expect((await bounded`SELECT count(*)::int AS count FROM timeout_probe`)[0]!.count).toBe(1);
    } finally { await bounded.end(); }
  }, 10_000);
  it("cancels blocked writes at lock_timeout and keeps the prior committed value", async () => {
    const owner = await db.reserve();
    try {
      await owner`BEGIN`;
      await owner`UPDATE timeout_probe SET value=1 WHERE id=1`;
      await expect(db`UPDATE timeout_probe SET value=2 WHERE id=1`).rejects.toMatchObject({ code: "55P03" });
    } finally { await owner`ROLLBACK`; owner.release(); }
    expect((await db`SELECT value FROM timeout_probe WHERE id=1`)[0]!.value).toBe(0);
  }, 10_000);
  it("aborts an eight-second transaction, rolls back its writes and reconnects with the same bounds", async () => {
    // A one-connection pool proves recovery cannot come from an unaffected second session.
    vi.stubEnv("SOFINANCE_RWA_DB_POOL_MAX", "1");
    const isolated = createRwaDatabase(url!, schema);
    vi.stubEnv("SOFINANCE_RWA_DB_POOL_MAX", "2");
    try {
      const [before] = await isolated`SELECT pg_backend_pid() AS pid`;
      await expect(isolated.begin(async tx => {
        await tx`INSERT INTO timeout_probe VALUES (2,99)`;
        for (let i = 0; i < 20; i++) await tx`SELECT pg_sleep(0.5)`;
      })).rejects.toHaveProperty("code", expect.stringMatching(/^(25P04|ECONNRESET|CONNECTION_CLOSED)$/));
      expect((await isolated`SELECT count(*)::int AS count FROM timeout_probe WHERE id=2`)[0]!.count).toBe(0);
      const [settings] = await isolated`SELECT pg_backend_pid() AS pid,current_setting('transaction_timeout') AS timeout,current_schema() AS schema`;
      expect(settings).toMatchObject({ timeout: "8s", schema });
      expect(settings!.pid).not.toBe(before!.pid);
    } finally { await isolated.end({ timeout: 2 }); }
  }, 15_000);
});

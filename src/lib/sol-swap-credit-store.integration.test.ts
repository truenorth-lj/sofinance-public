/** Real SQL checks are confined to a disposable schema in the dedicated database. */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.setConfig({ testTimeout: 30_000 });
import { createRwaDatabase } from "./rwa-postgres-store";
import { PostgresSolSwapCreditStore } from "./sol-swap-credit-store";

const url = process.env.RWA_DB_TEST_URL;
describe.skipIf(!url)("SOL swap fee-credit ledger PostgreSQL persistence", () => {
  const schema = `sol_swap_credit_it_${randomUUID().replaceAll("-", "")}`;
  const db = url ? createRwaDatabase(url, schema) : null;
  const store = db ? new PostgresSolSwapCreditStore(db) : null;
  const wallet = "4".repeat(32), hashA = "A".repeat(32), hashB = "B".repeat(32), hashC = "C".repeat(32);
  const claim = (swapSignature: string, openBlockhash = hashA, openLastValidBlockHeight = 1_150) =>
    ({ swapSignature, wallet, openBlockhash, openLastValidBlockHeight });
  beforeAll(async () => {
    await db!.unsafe(`CREATE SCHEMA ${schema}`);
    for (const migration of readMigrationFiles({ migrationsFolder: resolve("drizzle") }))
      for (const statement of migration.sql) await db!.unsafe(statement.replaceAll('"public".', `"${schema}".`));
  }, 30_000);
  afterAll(async () => {
    if (db) { await db.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end(); }
  }, 30_000);

  it("claims a swap once; a second claim returns the existing open instead", async () => {
    const a = "a".repeat(64);
    expect(await store!.claim(claim(a))).toEqual({ claimed: true });
    expect(await store!.claim(claim(a, hashB, 2_000))).toEqual({ claimed: false, existing: claim(a) });
  });

  it("lets exactly one of many concurrent first claims win", async () => {
    const b = "b".repeat(64);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => store!.claim(claim(b, i % 2 ? hashB : hashA))));
    expect(results.filter((result) => result.claimed)).toHaveLength(1);
  });

  it("moves a claim only from the blockhash it is bound to (compare-and-set), counting claims", async () => {
    const c = "c".repeat(64);
    await store!.claim(claim(c));
    const [first, second] = await Promise.all([
      store!.reclaim({ ...claim(c, hashB, 1_300), previousBlockhash: hashA }),
      store!.reclaim({ ...claim(c, hashC, 1_301), previousBlockhash: hashA }),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await store!.reclaim({ ...claim(c, hashC, 1_302), previousBlockhash: hashA })).toBe(false);
    expect(await store!.reclaim({ ...claim(c, hashC, 1_302), wallet: "5".repeat(32), previousBlockhash: first ? hashB : hashC })).toBe(false);
    const [row] = await db!.unsafe(`SELECT open_blockhash, claims FROM ${schema}.sol_swap_fee_credits WHERE swap_signature = '${c}'`);
    expect(row).toEqual({ open_blockhash: first ? hashB : hashC, claims: 2 });
  });

  it("rejects malformed keys at the database", async () => {
    await expect(store!.claim(claim("not-a-signature"))).rejects.toThrow();
    await expect(store!.claim({ ...claim("d".repeat(64)), openBlockhash: "0".repeat(32) })).rejects.toThrow();
    await expect(store!.claim({ ...claim("e".repeat(64)), openLastValidBlockHeight: -1 })).rejects.toThrow();
  });
});

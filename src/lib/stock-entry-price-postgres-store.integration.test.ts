/** Real SQL checks are confined to a disposable schema in the dedicated database. */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.setConfig({ testTimeout: 30_000 });
import { createRwaDatabase } from "./rwa-postgres-store";
import { PostgresStockEntryPriceStore } from "./stock-entry-price-postgres-store";
import type { StockEntryPriceRow } from "./stock-entry-price-store-types";

const url = process.env.RWA_DB_TEST_URL;
describe.skipIf(!url)("Stock entry price PostgreSQL persistence", () => {
  const schema = `entry_price_it_${randomUUID().replaceAll("-", "")}`;
  const db = url ? createRwaDatabase(url, schema) : null;
  const store = db ? new PostgresStockEntryPriceStore(db) : null;
  const mint = "4".repeat(32), pool = "5".repeat(32);
  const ok = (signature: string, priceUsd = 176.998, methodVersion = 1): StockEntryPriceRow => ({
    depositSignature: signature, priceMint: mint, depositSlot: 467_424_095, depositBlockTime: 1_794_250_173, referencePool: pool,
    methodVersion, status: "ok", priceUsd, trades: [{ signature: "t".repeat(64), blockTime: 1_794_250_171, priceUsd, usdcSize: 258.69 }] });
  beforeAll(async () => {
    await db!.unsafe(`CREATE SCHEMA ${schema}`);
    for (const migration of readMigrationFiles({ migrationsFolder: resolve("drizzle") }))
      for (const statement of migration.sql) await db!.unsafe(statement.replaceAll('"public".', `"${schema}".`));
  }, 30_000);
  afterAll(async () => {
    if (db) { await db.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end(); }
  }, 30_000);

  it("writes a deposit once, reuses ok rows of any method version, and hides old-version no_trade", async () => {
    const a = "a".repeat(64), b = "b".repeat(64);
    expect(await store!.request({ op: "write", rows: [ok(a), { ...ok(b), status: "no_trade", priceUsd: null, trades: [] }] })).toBe(2);
    expect(await store!.request({ op: "write", rows: [ok(a, 999)] })).toBe(0);
    const v1 = await store!.request({ op: "read", priceMint: mint, methodVersion: 1, signatures: [a, b, "c".repeat(64)] });
    expect(v1.find((row) => row.depositSignature === a)).toMatchObject({ status: "ok", priceUsd: 176.998, trades: [{ usdcSize: 258.69 }] });
    expect(v1.find((row) => row.depositSignature === b)).toMatchObject({ status: "no_trade", priceUsd: null, trades: [] });
    const v2 = await store!.request({ op: "read", priceMint: mint, methodVersion: 2, signatures: [a, b] });
    expect(v2.find((row) => row.depositSignature === a)).toMatchObject({ status: "ok", priceUsd: 176.998, methodVersion: 1 });
    expect(v2.find((row) => row.depositSignature === b)).toBeUndefined();
  });

  it("replaces only an older no_trade with a newer method version, and never an ok", async () => {
    const d = "d".repeat(64), g = "g".repeat(64);
    await store!.request({ op: "write", rows: [ok(d, 100)] });
    expect(await store!.request({ op: "write", rows: [ok(d, 101, 2)] })).toBe(0);
    expect(await store!.request({ op: "read", priceMint: mint, methodVersion: 2, signatures: [d] })).toMatchObject([{ priceUsd: 100, methodVersion: 1 }]);
    await store!.request({ op: "write", rows: [{ ...ok(g, 100), status: "no_trade", priceUsd: null, trades: [] }] });
    expect(await store!.request({ op: "write", rows: [ok(g, 101, 2)] })).toBe(1);
    expect(await store!.request({ op: "read", priceMint: mint, methodVersion: 2, signatures: [g] })).toMatchObject([{ priceUsd: 101, methodVersion: 2 }]);
  });

  it("rejects rows the checks forbid", async () => {
    await expect(db!`INSERT INTO position_entry_prices(deposit_signature,price_mint,deposit_slot,deposit_block_time,reference_pool,status,price_usd,method_version)
      VALUES(${"e".repeat(64)},${mint},1,1,${pool},'ok',NULL,1)`).rejects.toThrow();
    await expect(db!`INSERT INTO position_entry_prices(deposit_signature,price_mint,deposit_slot,deposit_block_time,reference_pool,status,price_usd,method_version)
      VALUES(${"f".repeat(64)},${mint},1,1,${pool},'no_trade',5,1)`).rejects.toThrow();
  });
});

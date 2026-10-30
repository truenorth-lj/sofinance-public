import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { resolve } from "node:path";
import { positionHistoryState, positionHistoryTransactions } from "../db/schema";
import { positionStoreRequestSchema } from "./position-history-store-types";

const lease = { positionMint: "1".repeat(32), owner: "b60481d7-4ea4-4e4e-881a-e2d5c90fc44a", epoch: 1, revision: 0 };
const transaction = { signature: "a".repeat(64), slot: 1, blockTime: 10, status: "parsed",
  receipt: { meta: { logMessages: [] } }, parserVersion: 1, events: [{ kind: "increase",
    positionNftMint: lease.positionMint, liquidity: "100000000000000000000", amountA: "10", amountB: "20" }] };
const commit = { op: "commit", lease, state: { headSignature: transaction.signature,
  backfillBefore: null, complete: false, parserVersion: 1 }, transactions: [transaction] };
describe("position history schema and transport validation", () => {
  it("adds exactly the two approved tables, keeps replay events and enforces fixed network identity", () => {
    const tables = [positionHistoryState, positionHistoryTransactions].map(getTableConfig);
    expect(tables.map((table) => table.name)).toEqual(["position_history_state", "position_history_transactions"]);
    expect(tables[0]!.checks.map((check) => check.name)).toContain("position_history_state_identity_check");
    expect(tables[1]!.foreignKeys).toHaveLength(1);
    expect(tables[1]!.primaryKeys[0]!.columns.map((column) => column.name)).toEqual(["position_mint", "signature"]);
    const migration = readMigrationFiles({ migrationsFolder: resolve("drizzle") })
      .find((entry) => entry.sql.some((statement) => statement.includes('CREATE TABLE "position_history_state"')))!;
    const ddl = migration.sql.join("\n");
    expect(ddl.match(/CREATE TABLE/g)).toHaveLength(2);
    expect(ddl).toContain("mainnet-beta");
    expect(ddl).not.toMatch(/DROP |TRUNCATE |ALTER TABLE "rwa_/);
  });
  it("keeps raw integer amounts as exact strings and accepts replayable receipts", () => {
    const parsed = positionStoreRequestSchema.parse(commit);
    expect(parsed).toEqual(commit);
    expect(positionStoreRequestSchema.safeParse({ ...commit, transactions: [{ ...transaction,
      events: [{ ...transaction.events[0], amountA: 10 }] }] }).success).toBe(false);
    expect(positionStoreRequestSchema.safeParse({ ...commit, transactions: [{ ...transaction, slot: Number.MAX_SAFE_INTEGER + 1 }] }).success).toBe(false);
    expect(positionStoreRequestSchema.safeParse({ ...commit, transactions: [{ ...transaction, signature: "invalid" }] }).success).toBe(false);
    expect(positionStoreRequestSchema.safeParse({ ...commit, lease: { ...lease, epoch: 0 } }).success).toBe(false);
  });
  it("validates resumable delta cursors and empty events for ignored transactions", () => {
    expect(positionStoreRequestSchema.safeParse({ ...commit, state: { ...commit.state,
      deltaBefore: transaction.signature, deltaHead: null } }).success).toBe(true);
    expect(positionStoreRequestSchema.safeParse({ ...commit, state: { ...commit.state,
      deltaBefore: "invalid" } }).success).toBe(false);
    expect(positionStoreRequestSchema.safeParse({ ...commit, transactions: [{ ...transaction,
      status: "ignored", events: [] }] }).success).toBe(true);
    expect(positionStoreRequestSchema.safeParse({ ...commit, transactions: [{ ...transaction,
      status: "ignored" }] }).success).toBe(false);
  });
  it("bounds each mutation batch and rejects invalid parser versions", () => {
    expect(positionStoreRequestSchema.safeParse({ ...commit, transactions: Array(500).fill(transaction) }).success).toBe(true);
    expect(positionStoreRequestSchema.safeParse({ ...commit, transactions: Array(501).fill(transaction) }).success).toBe(false);
    expect(positionStoreRequestSchema.safeParse({ ...commit, state: { ...commit.state, parserVersion: 0 } }).success).toBe(false);
  });
});

import "server-only";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema";
import {
  MAX_POSITION_HISTORY_TRANSACTIONS, POSITION_HISTORY_LEASE_MS, PositionHistoryStoreError, positionStoreRequestSchema,
  type PositionContext, type PositionHistoryLease, type PositionHistorySnapshot,
  type PositionHistoryStore, type PositionStoreRequest, type StoredPositionTransaction,
} from "./position-history-store-types";

const { positionHistoryState: state, positionHistoryTransactions: history } = schema;
type Database = PostgresJsDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export const MAX_POSITION_HISTORY_RESPONSE_BYTES = 3_500_000;
const now = sql`clock_timestamp()`;
const identity = (mint: string) => eq(state.positionMint, mint);
const leaseWhere = (lease: PositionHistoryLease) => and(identity(lease.positionMint),
  eq(state.leaseOwner, lease.owner), eq(state.leaseEpoch, lease.epoch), eq(state.revision, lease.revision),
  gt(state.leaseExpiresAt, now));

/** Request-triggered history only. All RPC and parsing happen outside these short transactions. */
export class PostgresPositionHistoryStore implements PositionHistoryStore {
  private readonly orm: Database;
  constructor(public readonly db: postgres.Sql) { this.orm = drizzle(db, { schema }); }

  async request(raw: PositionStoreRequest): Promise<unknown> {
    const input = positionStoreRequestSchema.parse(raw);
    if (input.op === "claim") return this.claim(input.context, input.parserVersion);
    if (input.op === "release") {
      // A stale owner must never release the replacement lease; release is idempotent.
      const released = await this.orm.update(state).set({ leaseOwner: null, leaseExpiresAt: null })
        .where(and(identity(input.lease.positionMint), eq(state.leaseOwner, input.lease.owner),
          eq(state.leaseEpoch, input.lease.epoch))).returning({ mint: state.positionMint });
      return released.length > 0;
    }
    return this.commit(input);
  }

  private async snapshot(tx: Transaction, row: typeof state.$inferSelect, parserVersion: number,
    lease: PositionHistoryLease | null): Promise<PositionHistorySnapshot> {
    const result: PositionHistorySnapshot = { lease, state: {
      headSignature: row.headSignature, backfillBefore: row.backfillBefore,
      deltaBefore: row.deltaBefore, deltaHead: row.deltaHead,
      complete: row.complete, revision: row.revision, parserVersion: row.parserVersion }, transactions: [] };
    // Preflight only a bounded count and byte total across PostgreSQL, never oversized event arrays.
    // PostgreSQL's JSON spacing makes this a conservative upper bound for JSON.stringify.
    const [size] = await tx.execute<{ count: number; bytes: string }>(sql`
      SELECT count(*)::integer AS count,COALESCE(SUM(octet_length(jsonb_build_object(
        'signature',signature,'slot',slot,'blockTime',block_time,'status',status,
        'events',events,'parserVersion',parser_version,'receipt',NULL)::text)),0)::bigint AS bytes
      FROM (SELECT signature,slot,block_time,status,events,parser_version FROM ${history}
        WHERE position_mint=${row.positionMint} ORDER BY slot,signature
        LIMIT ${MAX_POSITION_HISTORY_TRANSACTIONS + 1}) bounded`);
    if (size!.count > MAX_POSITION_HISTORY_TRANSACTIONS)
      throw new PositionHistoryStoreError("POSITION_HISTORY_TOO_LARGE");
    const projectedBytes = Buffer.byteLength(JSON.stringify(result)) + Number(size!.bytes) + Math.max(0, size!.count - 1);
    if (projectedBytes > MAX_POSITION_HISTORY_RESPONSE_BYTES)
      throw new PositionHistoryStoreError("POSITION_HISTORY_RESPONSE_TOO_LARGE");
    const rows = await tx.select({ signature: history.signature, slot: history.slot,
      blockTime: history.blockTime, status: history.status, events: history.events,
      parserVersion: history.parserVersion, receipt: sql<Record<string, unknown> | null>`NULL`,
    }).from(history).where(eq(history.positionMint, row.positionMint))
      .orderBy(asc(history.slot), asc(history.signature)).limit(MAX_POSITION_HISTORY_TRANSACTIONS + 1);
    if (rows.length > MAX_POSITION_HISTORY_TRANSACTIONS)
      throw new PositionHistoryStoreError("POSITION_HISTORY_TOO_LARGE");
    result.transactions = rows;
    const metadataBytes = Buffer.byteLength(JSON.stringify(result));
    if (metadataBytes > MAX_POSITION_HISTORY_RESPONSE_BYTES)
      throw new PositionHistoryStoreError("POSITION_HISTORY_RESPONSE_TOO_LARGE");
    const receiptBudget = MAX_POSITION_HISTORY_RESPONSE_BYTES - metadataBytes;
    // Measure raw JSON in PostgreSQL before loading it into the gateway process. A giant
    // individual receipt is omitted before the cumulative sum so smaller rows still progress.
    const receipts = await tx.execute<{ signature: string; receipt: Record<string, unknown> }>(sql`
      WITH candidates AS (
        SELECT signature,slot,octet_length(receipt::text)+128 AS byte_cost
        FROM ${history} WHERE position_mint=${row.positionMint} AND receipt IS NOT NULL
          AND status<>'ignored' AND (status='pending' OR parser_version<>${parserVersion})
      ), eligible AS (
        SELECT signature,slot,SUM(byte_cost) OVER(ORDER BY slot,signature ROWS UNBOUNDED PRECEDING) AS running_bytes
        FROM candidates WHERE byte_cost<=${receiptBudget}
      ), bounded AS (
        SELECT signature,slot FROM eligible WHERE running_bytes<=${receiptBudget}
        ORDER BY slot,signature LIMIT 500
      )
      SELECT h.signature,h.receipt FROM ${history} h JOIN bounded b ON h.signature=b.signature
      WHERE h.position_mint=${row.positionMint} ORDER BY b.slot,b.signature`);
    const receiptBySignature = new Map(receipts.map((receipt) => [receipt.signature, receipt.receipt]));
    for (const transaction of rows) transaction.receipt = receiptBySignature.get(transaction.signature) ?? null;
    // Defensive serialization check also covers driver JSON encoding differences.
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_POSITION_HISTORY_RESPONSE_BYTES)
      throw new PositionHistoryStoreError("POSITION_HISTORY_RESPONSE_TOO_LARGE");
    return result;
  }

  private async claim(context: PositionContext, parserVersion: number): Promise<PositionHistorySnapshot> {
    return this.orm.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL transaction_timeout = '8s'`);
      await tx.insert(state).values({ positionMint: context.positionMint, context, parserVersion }).onConflictDoNothing();
      const [old] = await tx.select().from(state).where(identity(context.positionMint)).for("update");
      if (!old || Object.entries(context).some(([key, value]) => old.context[key as keyof PositionContext] !== value))
        throw new PositionHistoryStoreError("CONTEXT_MISMATCH");
      const [claimed] = await tx.update(state).set({ leaseOwner: randomUUID(), leaseEpoch: sql`${state.leaseEpoch}+1`,
        leaseExpiresAt: sql`${now}+(${POSITION_HISTORY_LEASE_MS}::integer * interval '1 millisecond')` })
        .where(and(identity(context.positionMint), sql`(${state.leaseOwner} IS NULL OR ${state.leaseExpiresAt}<=${now})`))
        .returning();
      const lease = claimed ? { positionMint: claimed.positionMint, owner: claimed.leaseOwner!,
        epoch: claimed.leaseEpoch, revision: claimed.revision } : null;
      return this.snapshot(tx, claimed ?? old, parserVersion, lease);
    });
  }

  private async commit(input: Extract<PositionStoreRequest, { op: "commit" }>): Promise<PositionHistorySnapshot> {
    if (new Set(input.transactions.map((row) => row.signature)).size !== input.transactions.length)
      throw new PositionHistoryStoreError("DUPLICATE_TRANSACTION");
    return this.orm.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL transaction_timeout = '8s'`);
      const [old] = await tx.select().from(state).where(leaseWhere(input.lease)).for("update");
      if (!old) throw new PositionHistoryStoreError("LEASE_LOST");
      const previousRows = input.transactions.length ? await tx.select({ signature: history.signature,
        slot: history.slot, blockTime: history.blockTime, status: history.status, events: history.events,
        parserVersion: history.parserVersion }).from(history)
        .where(and(eq(history.positionMint, old.positionMint), sql`${history.signature} IN (${sql.join(input.transactions.map((row) => sql`${row.signature}`), sql`, `)})`)) : [];
      const previousBySignature = new Map(previousRows.map((row) => [row.signature, row]));
      const [storedCount] = await tx.select({ count: sql<number>`count(*)::integer` }).from(history)
        .where(eq(history.positionMint, old.positionMint));
      const additions = input.transactions.filter((transaction) => !previousBySignature.has(transaction.signature)).length;
      if (storedCount!.count + additions > MAX_POSITION_HISTORY_TRANSACTIONS)
        throw new PositionHistoryStoreError("POSITION_HISTORY_TOO_LARGE");
      const changes: (typeof history.$inferInsert)[] = [];
      for (const transaction of input.transactions) {
        if ((transaction.status !== "ignored" && transaction.parserVersion !== input.state.parserVersion) || transaction.events.some((event) =>
          event.kind === "open" ? event.poolState !== old.context.poolId : event.positionNftMint !== old.positionMint))
          throw new PositionHistoryStoreError("INVALID_TRANSACTION");
        const previous = previousBySignature.get(transaction.signature);
        if (previous && previous.slot !== transaction.slot) throw new PositionHistoryStoreError("TRANSACTION_SLOT_MISMATCH");
        const values: StoredPositionTransaction = { ...transaction };
        // A caller supplies only changed transactions; the equality check also makes retry writes cheap.
        if (previous && values.receipt === null && ["slot", "blockTime", "status", "events", "parserVersion"].every((key) =>
          JSON.stringify(previous[key as keyof typeof previous]) === JSON.stringify(values[key as keyof StoredPositionTransaction]))) continue;
        changes.push({ positionMint: old.positionMint, ...values });
      }
      if (changes.length) await tx.insert(history).values(changes).onConflictDoUpdate({
        target: [history.positionMint, history.signature], set: {
          slot: sql`excluded.slot`, blockTime: sql`excluded.block_time`, status: sql`excluded.status`,
          receipt: sql`COALESCE(excluded.receipt,${history.receipt})`, events: sql`excluded.events`, parserVersion: sql`excluded.parser_version`, updatedAt: now,
        },
        setWhere: sql`ROW(${history.slot},${history.blockTime},${history.status},${history.receipt},${history.events},${history.parserVersion})
          IS DISTINCT FROM ROW(excluded.slot,excluded.block_time,excluded.status,COALESCE(excluded.receipt,${history.receipt}),excluded.events,excluded.parser_version)`,
      });
      const [pending] = await tx.select({ signature: history.signature }).from(history)
        .where(and(eq(history.positionMint, old.positionMint), sql`${history.status}<>'ignored' AND (${history.status}='pending' OR ${history.parserVersion}<>${input.state.parserVersion})`)).limit(1);
      if (pending && (input.state.headSignature !== old.headSignature || input.state.backfillBefore !== old.backfillBefore || (!old.complete && input.state.complete)))
        throw new PositionHistoryStoreError("INCOMPLETE_HISTORY");
      if (old.complete && !input.state.complete) throw new PositionHistoryStoreError("COMPLETE_HISTORY_REGRESSION");
      if (input.state.headSignature) {
        const [head] = await tx.select({ signature: history.signature }).from(history)
          .where(and(eq(history.positionMint, old.positionMint), eq(history.signature, input.state.headSignature)));
        if (!head) throw new PositionHistoryStoreError("UNKNOWN_HEAD");
      }
      if (input.state.complete && !pending) {
        const [opening] = await tx.select({ signature: history.signature }).from(history)
          .where(and(eq(history.positionMint, old.positionMint), eq(history.status, "parsed"), eq(history.parserVersion, input.state.parserVersion),
            sql`EXISTS(SELECT 1 FROM jsonb_array_elements(${history.events}) e WHERE e->>'kind'='open')`)).limit(1);
        if (!opening) throw new PositionHistoryStoreError("MISSING_OPENING_EVENT");
      }
      // Fence after every transaction write; failures roll all of them back.
      const [updated] = await tx.update(state).set({ ...input.state, revision: sql`${state.revision}+1`, updatedAt: now })
        .where(leaseWhere(input.lease)).returning();
      if (!updated) throw new PositionHistoryStoreError("LEASE_LOST");
      const result = await this.snapshot(tx, updated, input.state.parserVersion, null);
      // Final expiry/epoch/revision fence covers the snapshot read too, then releases atomically.
      const released = await tx.update(state).set({ leaseOwner: null, leaseExpiresAt: null }).where(and(
        identity(input.lease.positionMint), eq(state.leaseOwner, input.lease.owner), eq(state.leaseEpoch, input.lease.epoch),
        eq(state.revision, updated.revision), gt(state.leaseExpiresAt, now))).returning({ mint: state.positionMint });
      if (!released.length) throw new PositionHistoryStoreError("LEASE_LOST");
      return result;
    });
  }
}

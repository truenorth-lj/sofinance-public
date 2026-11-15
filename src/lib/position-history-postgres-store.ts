import "server-only";
import { randomUUID } from "node:crypto";
import { assertRwaDatabaseIdentity } from "./rwa-database";
import type postgres from "postgres";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema";
import {
  MAX_POSITION_HISTORY_TRANSACTIONS, POSITION_HISTORY_LEASE_MS, PositionHistoryStoreError, positionStoreRequestSchema,
  type PositionContext, type PositionHistoryLease, type PositionHistorySnapshot, type PositionHistoryReadSnapshot,
  type PositionHistoryStore, type PositionStoreRequest, type PositionStoreOperation, type PositionStoreResultMap, type PositionStoreHandlers, type StoredPositionTransaction,
} from "./position-history-store-types";

const { positionHistoryState: state, positionHistoryTransactions: history } = schema;
type Database = PostgresJsDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export const MAX_POSITION_HISTORY_RESPONSE_BYTES = 3_500_000;
const now = sql`clock_timestamp()`;
const leaseStartedAt = sql`${state.leaseExpiresAt}-(${POSITION_HISTORY_LEASE_MS}::integer * interval '1 millisecond')`;
const identity = (mint: string) => eq(state.positionMint, mint);
const leaseWhere = (lease: PositionHistoryLease) => and(identity(lease.positionMint),
  eq(state.leaseOwner, lease.owner), eq(state.leaseEpoch, lease.epoch), eq(state.revision, lease.revision),
  gt(state.leaseExpiresAt, now));

/** Request-triggered history only. All RPC and parsing happen outside these short transactions. */
export class PostgresPositionHistoryStore implements PositionHistoryStore {
  private readonly orm: Database;
  constructor(public readonly db: postgres.Sql) { this.orm = drizzle(db, { schema }); }

  async request<K extends PositionStoreOperation>(raw: PositionStoreRequest<K>): Promise<PositionStoreResultMap[K]> {
    // Parsing preserves op while applying its schema; the assertion retains that generic relationship.
    const input = positionStoreRequestSchema.parse(raw) as PositionStoreRequest<K>;
    await assertRwaDatabaseIdentity(this.db);
    return this.handlers[input.op](input);
  }

  private readonly handlers: PositionStoreHandlers = {
    read: input => this.read(input.context),
    claim: input => this.claim(input.context, input.parserVersion),
    release: async input => {
      // A stale owner must never release the replacement lease; release is idempotent.
      // Only a completed check may refresh the persisted timestamp. A late or
      // replaced worker cannot claim freshness after losing its revision/lease.
      const released = await this.orm.update(state).set({ leaseOwner: null, leaseExpiresAt: null,
        ...(input.checked ? { updatedAt: leaseStartedAt } : {}) })
        .where(input.checked ? leaseWhere(input.lease) : and(identity(input.lease.positionMint),
          eq(state.leaseOwner, input.lease.owner), eq(state.leaseEpoch, input.lease.epoch)))
        .returning({ mint: state.positionMint });
      return released.length > 0;
    },
    commit: input => this.commit(input),
  };

  private async read(context: PositionContext): Promise<PositionHistoryReadSnapshot | null> {
    // One statement supplies a consistent MVCC view of state and transactions.
    // Count/byte guards run before the scalar aggregate is evaluated, so an
    // oversized event ledger never crosses the database transport. Receipts are
    // excluded even when a newer parser would need them for background replay.
    const [row] = await this.orm.execute<{ context: PositionContext; count: number;
      snapshot: PositionHistoryReadSnapshot | null }>(sql`
      WITH bounded AS MATERIALIZED (
        SELECT slot,signature,jsonb_build_object('signature',signature,'slot',slot,
          'blockTime',block_time,'status',status,'events',events,
          'parserVersion',parser_version,'receipt',NULL) AS payload
        FROM ${history} WHERE position_mint=${context.positionMint}
        ORDER BY slot,signature LIMIT ${MAX_POSITION_HISTORY_TRANSACTIONS + 1}
      ), size AS (
        SELECT count(*)::integer AS count,COALESCE(SUM(octet_length(payload::text)),0)::bigint AS bytes
        FROM bounded
      ), target AS (
        SELECT context,jsonb_build_object('lease',NULL,'state',jsonb_build_object(
          'headSignature',head_signature,'backfillBefore',backfill_before,
          'deltaBefore',delta_before,'deltaHead',delta_head,'complete',complete,
          'revision',revision,'parserVersion',parser_version),
          'updatedAt',updated_at,'readAt',statement_timestamp(),
          'syncing',COALESCE(lease_owner IS NOT NULL AND lease_expires_at>${now},false),
          'transactions','[]'::jsonb) AS metadata
        FROM ${state} WHERE position_mint=${context.positionMint}
      )
      SELECT target.context,size.count,CASE WHEN size.count<=${MAX_POSITION_HISTORY_TRANSACTIONS}
        AND size.bytes+octet_length(target.metadata::text)+GREATEST(size.count-1,0)<=${MAX_POSITION_HISTORY_RESPONSE_BYTES}
        THEN target.metadata||jsonb_build_object('transactions',COALESCE(
          (SELECT jsonb_agg(payload ORDER BY slot,signature) FROM bounded),'[]'::jsonb))
        ELSE NULL END AS snapshot
      FROM target CROSS JOIN size`);
    if (!row) return null;
    if (Object.entries(context).some(([key, value]) => row.context[key as keyof PositionContext] !== value))
      throw new PositionHistoryStoreError("CONTEXT_MISMATCH");
    if (row.count > MAX_POSITION_HISTORY_TRANSACTIONS)
      throw new PositionHistoryStoreError("POSITION_HISTORY_TOO_LARGE");
    if (!row.snapshot || Buffer.byteLength(JSON.stringify(row.snapshot)) > MAX_POSITION_HISTORY_RESPONSE_BYTES)
      throw new PositionHistoryStoreError("POSITION_HISTORY_RESPONSE_TOO_LARGE");
    return { ...row.snapshot, updatedAt: new Date(row.snapshot.updatedAt).toISOString(),
      readAt: new Date(row.snapshot.readAt).toISOString() };
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
    // Warm ledgers need no receipt replay. Avoid a further database round trip
    // after the bounded metadata already proves every row is current.
    if (!rows.some((transaction) => transaction.status !== "ignored"
      && (transaction.status === "pending" || transaction.parserVersion !== parserVersion))) return result;
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
      const owner = randomUUID();
      const expiresAt = sql`${now}+(${POSITION_HISTORY_LEASE_MS}::integer * interval '1 millisecond')`;
      // The upsert locks an existing row before testing its lease. Concurrent
      // first readers therefore follow the same acquisition path as warm ones.
      const [claimed] = await tx.insert(state).values({ positionMint: context.positionMint, context, parserVersion,
        leaseOwner: owner, leaseEpoch: 1, leaseExpiresAt: expiresAt }).onConflictDoUpdate({
        target: state.positionMint,
        set: { leaseOwner: owner, leaseEpoch: sql`${state.leaseEpoch}+1`, leaseExpiresAt: expiresAt },
        setWhere: and(sql`${state.context} @> ${JSON.stringify(context)}::jsonb`,
          sql`(${state.leaseOwner} IS NULL OR ${state.leaseExpiresAt}<=${now})`),
      }).returning();
      // A busy lease or context mismatch returns no row. A new statement sees a
      // concurrent cold insertion after ON CONFLICT has waited for it to commit.
      const row = claimed ?? (await tx.select().from(state).where(identity(context.positionMint)).for("update"))[0];
      if (!row || Object.entries(context).some(([key, value]) => row.context[key as keyof PositionContext] !== value))
        throw new PositionHistoryStoreError("CONTEXT_MISMATCH");
      const lease = claimed ? { positionMint: claimed.positionMint, owner: claimed.leaseOwner!,
        epoch: claimed.leaseEpoch, revision: claimed.revision } : null;
      return this.snapshot(tx, row, parserVersion, lease);
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
      // Freshness describes when this worker started checking the chain. Its
      // later completion must not acknowledge a refresh requested in between.
      const [updated] = await tx.update(state).set({ ...input.state, revision: sql`${state.revision}+1`, updatedAt: leaseStartedAt })
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

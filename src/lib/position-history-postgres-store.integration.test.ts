/** Real SQL checks are confined to a disposable schema in the dedicated database. */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.setConfig({ testTimeout: 30_000 });
import { createRwaDatabase } from "./rwa-postgres-store";
import { MAX_POSITION_HISTORY_RESPONSE_BYTES, PostgresPositionHistoryStore } from "./position-history-postgres-store";
import { MAX_POSITION_HISTORY_TRANSACTIONS, type PositionContext, type StoredPositionTransaction } from "./position-history-store-types";

const url = process.env.RWA_DB_TEST_URL;
describe.skipIf(!url)("Position PostgreSQL persistence and fencing", () => {
  const schema = `position_it_${randomUUID().replaceAll("-", "")}`;
  const db = url ? createRwaDatabase(url, schema) : null;
  const store = db ? new PostgresPositionHistoryStore(db) : null;
  const context = (mint = "1".repeat(32)): PositionContext => ({ positionMint: mint,
    positionAccount: "2".repeat(32), poolId: "3".repeat(32), mintA: "4".repeat(32),
    mintB: "5".repeat(32), vaultA: "6".repeat(32), vaultB: "7".repeat(32) });
  const opening = (c: PositionContext, char = "a"): StoredPositionTransaction => ({
    signature: char.repeat(64), slot: 10, blockTime: 1000, status: "parsed", receipt: { logs: ["retained"] },
    parserVersion: 1, events: [{ kind: "open", poolState: c.poolId, nftOwner: "8".repeat(32),
      tickLower: 0, tickUpper: 10, liquidity: "12345678901234567890", amountA: "100", amountB: "200" }],
  });
  const claim = async (c = context(), parserVersion = 1) => await store!.request({ op: "claim", context: c, parserVersion });
  beforeAll(async () => {
    await db!.unsafe(`CREATE SCHEMA ${schema}`);
    for (const migration of readMigrationFiles({ migrationsFolder: resolve("drizzle") }))
      for (const statement of migration.sql) await db!.unsafe(statement.replaceAll('"public".', `"${schema}".`));
    await db!`INSERT INTO rwa_feed_state(feed_key,pairing_rule_version,summary) VALUES('preserved','v1','{"retained":true}'::jsonb)`;
  }, 30_000);
  afterAll(async () => {
    if (db) { await db!.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end(); }
  }, 30_000);

  it("admits one simultaneous caller, round trips events, suppresses warm receipts and rejects stale revision", async () => {
    const c = context();
    const claims = await Promise.all([claim(c), claim(c)]);
    expect(claims.filter((s) => s.lease)).toHaveLength(1);
    const first = claims.find((s) => s.lease)!;
    const transaction = opening(c);
    const request = { op: "commit" as const, lease: first.lease!,
      state: { headSignature: transaction.signature, backfillBefore: null, complete: true, parserVersion: 1 }, transactions: [transaction] };
    const saved = await store!.request(request);
    expect(saved).toMatchObject({ lease: null, state: { complete: true, revision: 1 } });
    expect(saved.transactions).toEqual([{ ...transaction, receipt: null }]);
    await expect(store!.request(request)).rejects.toMatchObject({ code: "LEASE_LOST" });
    const warm = await claim(c);
    expect(warm.transactions[0]!.receipt).toBeNull();
    await store!.request({ op: "release", lease: warm.lease! });
    const upgraded = await claim(c, 2);
    expect(upgraded.transactions[0]!.receipt).toEqual(transaction.receipt);
    await store!.request({ op: "release", lease: upgraded.lease! });
    const [rwa] = await db!`SELECT summary FROM rwa_feed_state WHERE feed_key='preserved'`;
    expect(rwa!.summary).toEqual({ retained: true });
  });

  it("persists missing delta receipts without advancing a complete checkpoint, then repairs atomically", async () => {
    const c = context();
    const first = await claim(c);
    const pending: StoredPositionTransaction = { ...opening(c, "b"), slot: 11, status: "pending", events: [], receipt: { logs: null } };
    const next = { op: "commit" as const, lease: first.lease!, state: {
      headSignature: pending.signature, backfillBefore: null, complete: true, parserVersion: 1 }, transactions: [pending] };
    await expect(store!.request(next)).rejects.toMatchObject({ code: "INCOMPLETE_HISTORY" });
    expect(await db!`SELECT signature FROM position_history_transactions WHERE signature=${pending.signature}`).toHaveLength(0);
    await store!.request({ ...next, state: { ...next.state, headSignature: first.state.headSignature } });
    const retry = await claim(c);
    expect(retry.state.headSignature).toBe(first.state.headSignature);
    expect(retry.transactions.find((t) => t.signature === pending.signature)!.receipt).toEqual(pending.receipt);
    const parsed = { ...pending, status: "parsed" as const, receipt: null, events: [] };
    await store!.request({ ...next, lease: retry.lease!, transactions: [parsed] });
    const [retained] = await db!`SELECT receipt FROM position_history_transactions WHERE signature=${pending.signature}`;
    expect(retained!.receipt).toEqual(pending.receipt);
  });

  it("persists a parser-upgrade pending opening while retaining the prior complete checkpoint", async () => {
    const c = context("G".repeat(32)), first = await claim(c), transaction = opening(c, "f");
    const completeState = { headSignature: transaction.signature, backfillBefore: null, deltaBefore: null, deltaHead: null, complete: true, parserVersion: 1 };
    await store!.request({ op: "commit", lease: first.lease!, state: completeState, transactions: [transaction] });
    const upgrade = await claim(c, 2);
    const pending = { ...transaction, parserVersion: 2, status: "pending" as const, events: [], receipt: null };
    const saved = await store!.request({ op: "commit", lease: upgrade.lease!,
      state: { ...completeState, parserVersion: 2 }, transactions: [pending] });
    expect(saved.state).toEqual({ ...completeState, parserVersion: 2, revision: 2 });
    expect(saved.transactions).toEqual([{ ...pending, receipt: transaction.receipt }]);
    const retry = await claim(c, 2);
    expect(retry.transactions[0]!.status).toBe("pending");
    const repaired = await store!.request({ op: "commit", lease: retry.lease!,
      state: { ...completeState, parserVersion: 2 }, transactions: [{ ...transaction, parserVersion: 2, receipt: null }] });
    expect(repaired.state).toEqual({ ...completeState, parserVersion: 2, revision: 3 });
    expect(repaired.transactions[0]!.status).toBe("parsed");
    expect(repaired.transactions[0]!.receipt).toBeNull();
    const [raw] = await db!`SELECT receipt FROM position_history_transactions WHERE position_mint=${c.positionMint}`;
    expect(raw!.receipt).toEqual(transaction.receipt);
  });

  it("retains bounded delta progress without advancing a complete head across pending transactions", async () => {
    const c = context("H".repeat(32)), first = await claim(c), transaction = opening(c, "h");
    const completeState = { headSignature: transaction.signature, backfillBefore: null,
      deltaBefore: null, deltaHead: null, complete: true, parserVersion: 1 };
    await store!.request({ op: "commit", lease: first.lease!, state: completeState, transactions: [transaction] });
    const next = await claim(c), pending = { ...transaction, signature: "j".repeat(64), slot: 11,
      status: "pending" as const, events: [], receipt: null };
    const deltaState = { ...completeState, deltaBefore: pending.signature, deltaHead: pending.signature };
    const saved = await store!.request({ op: "commit", lease: next.lease!, state: deltaState, transactions: [pending] });
    expect(saved.state).toEqual({ ...deltaState, revision: 2 });
    const retry = await claim(c);
    await expect(store!.request({ op: "commit", lease: retry.lease!, state: { ...deltaState,
      headSignature: pending.signature }, transactions: [] })).rejects.toMatchObject({ code: "INCOMPLETE_HISTORY" });
    const repaired = await store!.request({ op: "commit", lease: retry.lease!, state: { ...completeState,
      headSignature: pending.signature }, transactions: [{ ...pending, status: "parsed" }] });
    expect(repaired.state).toEqual({ ...completeState, headSignature: pending.signature, revision: 3 });
  });

  it("permanently excludes ignored pre-opening rows from parser replay and pending checks", async () => {
    const c = context("J".repeat(32)), first = await claim(c), transaction = opening(c, "k");
    const ignored = { ...transaction, signature: "m".repeat(64), slot: 5, status: "ignored" as const, events: [] };
    const completeState = { headSignature: transaction.signature, backfillBefore: null,
      deltaBefore: null, deltaHead: null, complete: true, parserVersion: 1 };
    await store!.request({ op: "commit", lease: first.lease!, state: completeState, transactions: [ignored, transaction] });
    const upgrade = await claim(c, 2);
    expect(upgrade.transactions.find((row) => row.status === "ignored")!.receipt).toBeNull();
    expect(upgrade.transactions.find((row) => row.status === "parsed")!.receipt).toEqual(transaction.receipt);
    const saved = await store!.request({ op: "commit", lease: upgrade.lease!, state: { ...completeState, parserVersion: 2 },
      transactions: [ignored, { ...transaction, parserVersion: 2, receipt: null }] });
    expect(saved.state.complete).toBe(true);
    expect(saved.transactions.find((row) => row.status === "ignored")!.parserVersion).toBe(1);
    const [raw] = await db!`SELECT receipt FROM position_history_transactions WHERE position_mint=${c.positionMint} AND status='ignored'`;
    expect(raw!.receipt).toEqual(ignored.receipt);
    await expect(db!`INSERT INTO position_history_transactions(position_mint,signature,slot,status,events,parser_version)
      VALUES(${c.positionMint},${"n".repeat(64)},4,'ignored','[{}]'::jsonb,1)`)
      .rejects.toMatchObject({ constraint_name: "position_history_transactions_events_check" });
  });

  it("rejects incomplete completion, mismatched context and foreign position events", async () => {
    const c = context("9".repeat(32)), first = await claim(c), transaction = opening(c, "c");
    await expect(claim({ ...c, poolId: "A".repeat(32) })).rejects.toMatchObject({ code: "CONTEXT_MISMATCH" });
    await expect(store!.request({ op: "commit", lease: first.lease!, state: { ...first.state,
      complete: true, headSignature: transaction.signature }, transactions: [{ ...transaction, status: "pending", events: [] }] }))
      .rejects.toMatchObject({ code: "INCOMPLETE_HISTORY" });
    await expect(store!.request({ op: "commit", lease: first.lease!, state: first.state,
      transactions: [{ ...transaction, events: [{ kind: "increase", positionNftMint: context().positionMint,
        liquidity: "1", amountA: "1", amountB: "1" }] }] })).rejects.toMatchObject({ code: "INVALID_TRANSACTION" });
    await store!.request({ op: "release", lease: first.lease! });
  });

  it("fences expired epochs and prevents an old release from clearing a replacement lease", async () => {
    const c = context("B".repeat(32)), first = await claim(c);
    await db!`UPDATE position_history_state SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE position_mint=${c.positionMint}`;
    const replacement = await claim(c);
    expect(replacement.lease!.epoch).toBe(first.lease!.epoch + 1);
    expect(await store!.request({ op: "release", lease: first.lease! })).toBe(false);
    await expect(store!.request({ op: "commit", lease: first.lease!, state: first.state, transactions: [] }))
      .rejects.toMatchObject({ code: "LEASE_LOST" });
    expect((await claim(c)).lease).toBeNull();
    await store!.request({ op: "release", lease: replacement.lease! });
  });

  it("commits the maximum 500-row batch within a short SQL transaction", async () => {
    const c = context("D".repeat(32)), first = await claim(c);
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const rows = Array.from({ length: 500 }, (_, index) => {
      const signature = (alphabet[Math.floor(index / 58)]! + alphabet[index % 58]!).padStart(64, "1");
      return { ...opening(c), signature, slot: index + 100, events: index ? [] : opening(c).events,
        receipt: { meta: { logMessages: ["batch".repeat(400)] } } };
    });
    const saved = await store!.request({ op: "commit", lease: first.lease!,
      state: { ...first.state, headSignature: rows.at(-1)!.signature, complete: true }, transactions: rows });
    expect(saved.transactions).toHaveLength(500);
    expect(saved.state.revision).toBe(1);
    const [count] = await db!`SELECT count(*)::int AS count FROM position_history_transactions WHERE position_mint=${c.positionMint}`;
    expect(count!.count).toBe(500);
  });

  it("returns at most 500 replay receipts while preserving all transaction metadata and raw data", async () => {
    const c = context("E".repeat(32)), first = await claim(c);
    await store!.request({ op: "release", lease: first.lease! });
    await db!`INSERT INTO position_history_transactions(position_mint,signature,slot,block_time,status,receipt,events,parser_version)
      SELECT ${c.positionMint},lpad(translate(i::text,'0123456789','ABCDEFGHJK'),64,'1'),i,1000,'pending',
        '{"preserved":true}'::jsonb,'[]'::jsonb,1 FROM generate_series(1,501) i`;
    const saved = await claim(c);
    expect(saved.transactions).toHaveLength(501);
    expect(saved.transactions.filter((row) => row.receipt)).toHaveLength(500);
    const [raw] = await db!`SELECT count(*)::int AS count FROM position_history_transactions WHERE position_mint=${c.positionMint} AND receipt IS NOT NULL`;
    expect(raw!.count).toBe(501);
    await store!.request({ op: "release", lease: saved.lease! });
    await db!`UPDATE position_history_transactions SET status='parsed' WHERE position_mint=${c.positionMint}`;
    const upgraded = await claim(c, 2);
    expect(upgraded.transactions.filter((row) => row.receipt)).toHaveLength(500);
    await store!.request({ op: "release", lease: upgraded.lease! });
  });

  it("bounds replay receipt bytes before loading them and progresses past giant receipts on parser upgrades", async () => {
    const c = context("K".repeat(32)), first = await claim(c);
    await store!.request({ op: "release", lease: first.lease! });
    await db!`INSERT INTO position_history_transactions(position_mint,signature,slot,block_time,status,receipt,events,parser_version)
      SELECT ${c.positionMint},lpad(translate(i::text,'0123456789','ABCDEFGHJK'),64,'1'),i,1000,'parsed',
        jsonb_build_object('padding',repeat('x',16384)),'[]'::jsonb,1 FROM generate_series(1,500) i`;
    const giantSignature = "p".repeat(64);
    await db!`INSERT INTO position_history_transactions(position_mint,signature,slot,block_time,status,receipt,events,parser_version)
      VALUES(${c.positionMint},${giantSignature},0,1000,'parsed',
        jsonb_build_object('padding',repeat('x',${MAX_POSITION_HISTORY_RESPONSE_BYTES + 1000})),'[]'::jsonb,1)`;
    const upgrade = await claim(c, 2);
    expect(upgrade.transactions).toHaveLength(501);
    expect(upgrade.transactions.find((transaction) => transaction.signature === giantSignature)!.receipt).toBeNull();
    const supplied = upgrade.transactions.filter((transaction) => transaction.receipt);
    expect(supplied.length).toBeGreaterThan(0);
    expect(supplied.length).toBeLessThan(500);
    expect(Buffer.byteLength(JSON.stringify(upgrade))).toBeLessThanOrEqual(MAX_POSITION_HISTORY_RESPONSE_BYTES);
    expect(Buffer.byteLength(JSON.stringify(upgrade))).toBeLessThan(4 * 1024 * 1024);
    const saved = await store!.request({ op: "commit", lease: upgrade.lease!,
      state: { ...upgrade.state, parserVersion: 2 }, transactions: supplied.map((transaction) => ({
        ...transaction, parserVersion: 2, receipt: null })) });
    const nextReceipts = saved.transactions.filter((transaction) => transaction.receipt);
    expect(nextReceipts.length).toBeGreaterThan(0);
    const suppliedSignatures = new Set(supplied.map((transaction) => transaction.signature));
    expect(nextReceipts.every((transaction) => !suppliedSignatures.has(transaction.signature))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThanOrEqual(MAX_POSITION_HISTORY_RESPONSE_BYTES);
    const [raw] = await db!`SELECT count(*)::int AS count FROM position_history_transactions WHERE position_mint=${c.positionMint} AND receipt IS NOT NULL`;
    expect(raw!.count).toBe(501);
  });

  it("rejects oversized serialized metadata before committing a claimed lease", async () => {
    const c = context("L".repeat(32)), first = await claim(c);
    await store!.request({ op: "release", lease: first.lease! });
    const events = Array.from({ length: 100 }, () => ({ kind: "increase", positionNftMint: c.positionMint,
      liquidity: "1".repeat(78), amountA: "2".repeat(78), amountB: "3".repeat(78) }));
    await db!`INSERT INTO position_history_transactions(position_mint,signature,slot,block_time,status,receipt,events,parser_version)
      SELECT ${c.positionMint},lpad(translate(i::text,'0123456789','ABCDEFGHJK'),64,'1'),i,1000,'parsed',
        NULL,${JSON.stringify(events)}::jsonb,1 FROM generate_series(1,140) i`;
    await expect(claim(c)).rejects.toMatchObject({ code: "POSITION_HISTORY_RESPONSE_TOO_LARGE" });
    const [unchanged] = await db!`SELECT lease_owner,lease_epoch,revision FROM position_history_state WHERE position_mint=${c.positionMint}`;
    expect(unchanged!.lease_owner).toBeNull();
    expect(Number(unchanged!.lease_epoch)).toBe(first.lease!.epoch);
    expect(Number(unchanged!.revision)).toBe(0);
  });

  it("rejects count overflow before writes and rolls back oversized claims without retaining a lease", async () => {
    const c = context("F".repeat(32)), first = await claim(c);
    await db!`INSERT INTO position_history_transactions(position_mint,signature,slot,block_time,status,receipt,events,parser_version)
      SELECT ${c.positionMint},lpad(translate(i::text,'0123456789','ABCDEFGHJK'),64,'1'),i,1000,'parsed',NULL,'[]'::jsonb,1
      FROM generate_series(1,${MAX_POSITION_HISTORY_TRANSACTIONS}) i`;
    const addition = { ...opening(c, "e"), events: [] };
    await expect(store!.request({ op: "commit", lease: first.lease!, state: first.state, transactions: [addition] }))
      .rejects.toMatchObject({ code: "POSITION_HISTORY_TOO_LARGE" });
    const [afterFailure] = await db!`SELECT revision FROM position_history_state WHERE position_mint=${c.positionMint}`;
    expect(Number(afterFailure!.revision)).toBe(0);
    expect(await db!`SELECT signature FROM position_history_transactions WHERE position_mint=${c.positionMint} AND signature=${addition.signature}`).toHaveLength(0);
    // Updating an existing row at the cap must remain possible; only new unique signatures consume capacity.
    const update = { ...addition, signature: "B".padStart(64, "1"), slot: 1, receipt: { changed: true } };
    const capped = await store!.request({ op: "commit", lease: first.lease!, state: first.state, transactions: [update] });
    expect(capped.transactions).toHaveLength(MAX_POSITION_HISTORY_TRANSACTIONS);
    await db!`INSERT INTO position_history_transactions(position_mint,signature,slot,block_time,status,receipt,events,parser_version)
      VALUES(${c.positionMint},${addition.signature},${addition.slot},1000,'parsed',NULL,'[]'::jsonb,1)`;
    await expect(claim(c)).rejects.toMatchObject({ code: "POSITION_HISTORY_TOO_LARGE" });
    const [unchanged] = await db!`SELECT lease_owner,lease_epoch,revision FROM position_history_state WHERE position_mint=${c.positionMint}`;
    expect(unchanged!.lease_owner).toBeNull();
    expect(Number(unchanged!.lease_epoch)).toBe(first.lease!.epoch);
    expect(Number(unchanged!.revision)).toBe(1);
  });

  it("rolls back all transaction writes when the lease expires during commit", async () => {
    const c = context("C".repeat(32)), first = await claim(c), transaction = opening(c, "d");
    await db!.unsafe(`CREATE FUNCTION ${schema}.slow_position_write() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END$$`);
    await db!.unsafe(`CREATE TRIGGER slow_position_write BEFORE INSERT ON position_history_transactions FOR EACH ROW EXECUTE FUNCTION ${schema}.slow_position_write()`);
    try {
      await db!`UPDATE position_history_state SET lease_expires_at=clock_timestamp()+interval '100 milliseconds' WHERE position_mint=${c.positionMint}`;
      await expect(store!.request({ op: "commit", lease: first.lease!, state: { ...first.state,
        complete: true, headSignature: transaction.signature }, transactions: [transaction] }))
        .rejects.toMatchObject({ code: "LEASE_LOST" });
      expect(await db!`SELECT signature FROM position_history_transactions WHERE position_mint=${c.positionMint}`).toHaveLength(0);
      const [unchanged] = await db!`SELECT revision,complete FROM position_history_state WHERE position_mint=${c.positionMint}`;
      expect(Number(unchanged!.revision)).toBe(0);
      expect(unchanged!.complete).toBe(false);
    } finally { await db!.unsafe("DROP TRIGGER slow_position_write ON position_history_transactions"); }
  });
});

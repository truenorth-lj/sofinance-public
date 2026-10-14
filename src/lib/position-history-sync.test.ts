import { PublicKey, type ParsedTransactionWithMeta, type ConfirmedSignatureInfo,
  type SignaturesForAddressOptions, type Finality } from "@solana/web3.js";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { CLMM_PROGRAM_ID } from "@raydium-io/raydium-sdk-v2";
import { describe, expect, it, vi } from "vitest";
import { CREATE_PERSONAL_POSITION_DISC, INCREASE_LIQUIDITY_DISC,
  aggregateCashflowsForPosition, type PositionEventContext } from "./position-performance-events";
import { syncPositionHistory } from "./position-history-sync";
import { POSITION_HISTORY_PARSER_VERSION, positionStoreRequestSchema, type PositionHistorySnapshot,
  type PositionHistoryStore, type PositionStoreRequest } from "./position-history-store-types";
import type { HistoryConnection } from "./position-performance-history";

const key = () => PublicKey.unique().toBase58();
const context: PositionEventContext = { positionMint: key(), positionAccount: key(), poolId: key(),
  mintA: key(), mintB: key(), vaultA: key(), vaultB: key() };
const signature = (id: number) => {
  const bytes = Buffer.alloc(64, 1);
  bytes.writeUInt32BE(id, 60);
  return bs58.encode(bytes);
};

function receipt(id: number, kind: "open" | "increase" = "increase"): ParsedTransactionWithMeta {
  const payload = Buffer.alloc(kind === "open" ? 160 : 88);
  (kind === "open" ? CREATE_PERSONAL_POSITION_DISC : INCREASE_LIQUIDITY_DISC).copy(payload);
  new PublicKey(kind === "open" ? context.poolId : context.positionMint).toBuffer().copy(payload, 8);
  if (kind === "open") new PublicKey(key()).toBuffer().copy(payload, 72);
  const offset = kind === "open" ? 128 : 56;
  payload.writeBigUInt64LE(BigInt(id), offset);
  const instructions: ParsedTransactionWithMeta["transaction"]["message"]["instructions"] = [];
  if (kind === "open") {
    const data = createHash("sha256").update("global:open_position_with_token22_nft").digest().subarray(0, 8);
    const accounts = Array.from({ length: 9 }, () => new PublicKey(key()));
    accounts[2] = new PublicKey(context.positionMint);
    accounts[4] = new PublicKey(context.poolId);
    accounts[8] = new PublicKey(context.positionAccount);
    instructions.push({ programId: CLMM_PROGRAM_ID, accounts, data: bs58.encode(data) });
  }
  return { slot: id, blockTime: 1700000000 + id,
    transaction: { signatures: [signature(id)], message: { accountKeys: [], instructions, recentBlockhash: key() } },
    meta: { err: null, fee: 0, preBalances: [], postBalances: [],
      logMessages: [`Program data: ${payload.toString("base64")}`] } } as ParsedTransactionWithMeta;
}

class MemoryStore implements PositionHistoryStore {
  snapshot: PositionHistorySnapshot = { lease: null, state: { headSignature: null, backfillBefore: null,
    complete: false, revision: 0, parserVersion: POSITION_HISTORY_PARSER_VERSION }, transactions: [] };
  released = 0;
  claims = 0;
  locked = false;
  commitSizes: number[] = [];
  async request(input: PositionStoreRequest) {
    positionStoreRequestSchema.parse(input);
    if (input.op === "claim") {
      this.claims++;
      return { ...structuredClone(this.snapshot), lease: this.locked ? null : { positionMint: context.positionMint,
        owner: "2de80986-8a40-4a34-9d4e-c5f8b30a676e", epoch: this.claims, revision: this.snapshot.state.revision } };
    }
    if (input.op === "release") { this.released++; return null; }
    this.commitSizes.push(input.transactions.length);
    const rows = new Map(this.snapshot.transactions.map(row => [row.signature, row]));
    for (const row of input.transactions) rows.set(row.signature, structuredClone(row));
    this.snapshot = { lease: null, state: { ...input.state, revision: this.snapshot.state.revision + 1 },
      transactions: [...rows.values()] };
    return structuredClone(this.snapshot);
  }
}

function rpc(ids: number[], txs = new Map(ids.map(id => [id, receipt(id, id === 1 ? "open" : "increase")])), pageSize = 500) {
  const signatures = vi.fn(async (_address: PublicKey, options: SignaturesForAddressOptions | undefined,
    commitment: Finality | undefined): Promise<ConfirmedSignatureInfo[]> => {
    expect(commitment).toBe("finalized");
    const start = options?.before ? ids.findIndex(id => signature(id) === options.before) + 1 : 0;
    return ids.slice(start, start + Math.min(options?.limit ?? 500, pageSize)).map(id => ({
      signature: signature(id), slot: id, blockTime: 1700000000 + id, err: null, memo: null }));
  });
  const parsed = vi.fn(async (sig, options) => {
    expect(options.commitment).toBe("finalized");
    return txs.get(ids.find(id => signature(id) === sig)!) ?? null;
  });
  return { connection: { getSignaturesForAddress: signatures, getParsedTransaction: parsed } as HistoryConnection,
    signatures, parsed, ids, txs };
}

describe("incremental position history", () => {
  it("starts opening work past a slow newest receipt but never advances its checkpoint over a pending result", async () => {
    const store = new MemoryStore();
    const upstream = rpc(Array.from({ length: 9 }, (_, index) => 9 - index));
    let resolveNewest!: (value: ParsedTransactionWithMeta | null) => void;
    const newest = new Promise<ParsedTransactionWithMeta | null>(resolve => { resolveNewest = resolve; });
    const base = upstream.parsed.getMockImplementation()!;
    upstream.parsed.mockImplementation(async (sig, options) => sig === signature(9) ? newest : base(sig, options));
    const pending = syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 100 });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(upstream.parsed.mock.calls.some(([sig]) => sig === signature(1))).toBe(true);
    expect(store.commitSizes).toEqual([]);
    resolveNewest(null);
    const result = await pending;
    expect(result.truncated).toBe(true);
    expect(result.history).toHaveLength(8);
    expect(store.snapshot.state).toMatchObject({ headSignature: null, backfillBefore: null, complete: false });
    expect(store.snapshot.transactions.find(row => row.signature === signature(9))?.status).toBe("pending");
  });

  it("saves a paced cold 500-transaction backfill in five capped foreground requests before declaring completeness", async () => {
    const store = new MemoryStore();
    const upstream = rpc(Array.from({ length: 500 }, (_, index) => 500 - index));
    const run = () => syncPositionHistory({ context, store, connection: upstream.connection,
      maxSignatures: 500, maxDetailRequests: 100 });
    let totalDetailCalls = 0;
    for (let request = 1; request <= 5; request++) {
      const result = await run();
      expect(result.metric.detailBudget).toBe(100);
      expect(result.metric.fetchedTxCount).toBe(100);
      totalDetailCalls += 100;
      expect(upstream.parsed).toHaveBeenCalledTimes(totalDetailCalls);
      expect(result.signatureCount).toBe(request * 100);
      expect(result.history).toHaveLength(request * 100);
      expect(store.snapshot.state.headSignature).toBe(signature(500));
      expect(store.snapshot.state.backfillBefore).toBe(signature(501 - request * 100));
      if (request < 5) {
        expect(result.truncated).toBe(true);
        expect(result.metric.historyComplete).toBe(false);
        expect(result.metric.canContinue).toBe(true);
        expect(store.snapshot.state.complete).toBe(false);
      } else {
        expect(result.truncated).toBe(false);
        expect(result.metric.historyComplete).toBe(true);
        expect(store.snapshot.state.complete).toBe(true);
        const cash = aggregateCashflowsForPosition(result.history.flatMap(row => row.events), context.positionMint, context.poolId);
        expect(cash.depositedA).toBe(125250n);
        expect(cash.openCount).toBe(1);
      }
    }
    expect(store.commitSizes).toEqual([100, 100, 100, 100, 100]);
    const warm = await run();
    expect(warm.metric.fetchedTxCount).toBe(0);
    expect(upstream.parsed).toHaveBeenCalledTimes(500);
    upstream.ids.unshift(502, 501);
    upstream.txs.set(501, receipt(501)); upstream.txs.set(502, receipt(502));
    const delta = await run();
    expect(delta.truncated).toBe(false);
    expect(delta.metric.fetchedTxCount).toBe(2);
    expect(store.snapshot.state.headSignature).toBe(signature(502));
    expect(delta.history).toHaveLength(502);
  });

  it("clamps the transport detail allowance and never increases a caller's smaller requested budget", async () => {
    const upstream = rpc([3, 2, 1]);
    const small = await syncPositionHistory({ context, store: new MemoryStore(), connection: upstream.connection,
      maxSignatures: 1, maxDetailRequests: 100 });
    expect(small.metric).toMatchObject({ detailBudget: 1, fetchedTxCount: 1 });
    const invalid = await syncPositionHistory({ context, store: new MemoryStore(), connection: upstream.connection,
      maxSignatures: 100, maxDetailRequests: 0 });
    expect(invalid.metric).toMatchObject({ detailBudget: 1, fetchedTxCount: 1 });
    const high = await syncPositionHistory({ context, store: new MemoryStore(), connection: upstream.connection,
      maxSignatures: 100, maxDetailRequests: 1000 });
    expect(high.metric).toMatchObject({ detailBudget: 100, fetchedTxCount: 3 });
  });

  it("drains all started receipt work before releasing its lease after abort and never commits partial aborted work", async () => {
    const store = new MemoryStore();
    const upstream = rpc(Array.from({ length: 9 }, (_, index) => 9 - index));
    const resolvers = new Map<string, (value: ParsedTransactionWithMeta) => void>();
    upstream.parsed.mockImplementation(async sig => new Promise(resolve => { resolvers.set(sig, resolve); }));
    const controller = new AbortController();
    const pending = syncPositionHistory({ context, store, connection: upstream.connection,
      maxSignatures: 100, signal: controller.signal });
    let settled = false;
    const rejected = pending.catch(error => { settled = true; return error; });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(resolvers.size).toBe(8);
    const error = new Error("viewer cancelled");
    controller.abort(error);
    const [firstSig, firstResolve] = [...resolvers][0]!;
    firstResolve(upstream.txs.get(upstream.ids.find(id => signature(id) === firstSig)!)!);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(settled).toBe(false); expect(store.released).toBe(0);
    for (const [sig, resolve] of [...resolvers].slice(1)) resolve(upstream.txs.get(upstream.ids.find(id => signature(id) === sig)!)!);
    expect(await rejected).toBe(error);
    expect(store.released).toBe(1); expect(store.commitSizes).toEqual([]);
    expect(upstream.parsed).toHaveBeenCalledTimes(8);
  });

  it("includes claim, listing, logical detail wall time, commit and final release in completed metrics", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryStore();
      const request = store.request.bind(store);
      const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
      store.request = async input => {
        const result = await request(input);
        await wait(input.op === "claim" ? 7 : input.op === "commit" ? 13 : 17);
        return result;
      };
      const upstream = rpc([1]);
      const list = upstream.signatures.getMockImplementation()!;
      upstream.signatures.mockImplementation(async (...args) => { await wait(11); return list(...args); });
      const parsed = upstream.parsed.getMockImplementation()!;
      upstream.parsed.mockImplementation(async (...args) => { await wait(23); return parsed(...args); });
      const run = () => syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 100,
        rpcMetrics: () => ({ attemptCount: store.released, rateLimitCount: 0, queuedMs: 0, requestMs: 0,
          maxActive: 0, primaryAttempts: 0, defaultAttempts: 0, responseBytes: 0 }) });
      const cold = run();
      await vi.runAllTimersAsync();
      expect((await cold).metric).toMatchObject({ elapsedMs: 71, rpc: { attemptCount: 1 }, stages: {
        claimMs: 7, listingMs: 11, detailsMs: 23, parseMs: 0, commitMs: 13, releaseMs: 17 } });
      const warm = run();
      await vi.runAllTimersAsync();
      expect((await warm).metric).toMatchObject({ elapsedMs: 35, stages: {
        claimMs: 7, listingMs: 11, detailsMs: 0, parseMs: 0, commitMs: 0, releaseMs: 17 } });
      expect(store.commitSizes).toEqual([1]);
      store.locked = true;
      const locked = run();
      await vi.runAllTimersAsync();
      expect((await locked).metric).toMatchObject({ elapsedMs: 7, stages: {
        claimMs: 7, listingMs: 0, detailsMs: 0, parseMs: 0, commitMs: 0, releaseMs: 0 } });
      expect(store.released).toBe(2);
    } finally { vi.useRealTimers(); }
  });

  it("attributes observer-backed receipts to actual leaf providers and exposes unknown receipts without inventing Solami", async () => {
    const upstream = rpc([1]);
    const known = await syncPositionHistory({ context, store: new MemoryStore(), connection: upstream.connection,
      maxSignatures: 100, provider: "solami", receiptProvider: () => "default" });
    expect(known.metric).toMatchObject({ provider: "default", solamiTxCount: 0, defaultTxCount: 1, unattributedTxCount: 0 });
    const unknown = await syncPositionHistory({ context, store: new MemoryStore(), connection: upstream.connection,
      maxSignatures: 100, provider: "solami", receiptProvider: () => undefined });
    expect(unknown.metric).toMatchObject({ provider: "unknown", solamiTxCount: 0, defaultTxCount: 0, unattributedTxCount: 1 });
  });

  it("measures synchronous receipt parsing and replay without counting replay as new detail work", async () => {
    let ticks = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => ++ticks);
    try {
      const store = new MemoryStore();
      const upstream = rpc([1]);
      const run = () => syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 100 });
      expect((await run()).metric.stages?.parseMs).toBe(2);
      store.snapshot.transactions[0]!.parserVersion = 0;
      const replayed = await run();
      expect(replayed.metric.stages?.parseMs).toBe(2);
      expect(replayed.metric.stages?.detailsMs).toBe(0);
      expect(replayed.metric.fetchedTxCount).toBe(0);
      expect(upstream.parsed).toHaveBeenCalledTimes(1);
    } finally { clock.mockRestore(); }
  });

  it("drains active work and releases without committing when receipt serialization fails fatally", async () => {
    const store = new MemoryStore();
    const upstream = rpc(Array.from({ length: 9 }, (_, index) => 9 - index));
    const resolvers = new Map<string, (value: ParsedTransactionWithMeta) => void>();
    upstream.parsed.mockImplementation(async sig => new Promise(resolve => { resolvers.set(sig, resolve); }));
    const pending = syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 100 });
    let settled = false;
    const rejected = pending.catch(error => { settled = true; return error; });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const invalid = receipt(9);
    Object.assign(invalid, { circular: invalid });
    resolvers.get(signature(9))!(invalid);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(settled).toBe(false); expect(store.released).toBe(0);
    expect(upstream.parsed).toHaveBeenCalledTimes(8);
    for (const [sig, resolve] of [...resolvers].slice(1)) resolve(upstream.txs.get(upstream.ids.find(id => signature(id) === sig)!)!);
    expect(await rejected).toBeInstanceOf(TypeError);
    expect(store.released).toBe(1); expect(store.commitSizes).toEqual([]);
    expect(upstream.parsed).toHaveBeenCalledTimes(8);
  });

  it("fills cold history, fetches zero details warm, and fetches only live additions", async () => {
    const store = new MemoryStore();
    const upstream = rpc([3, 2, 1]);
    const run = () => syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 100 });
    const cold = await run();
    expect(cold.truncated).toBe(false);
    expect(cold.metric.fetchedTxCount).toBe(3);
    const warm = await run();
    expect(warm.metric.fetchedTxCount).toBe(0);
    expect(warm.history).toEqual(cold.history);
    expect(upstream.parsed).toHaveBeenCalledTimes(3);
    upstream.ids.unshift(4);
    upstream.txs.set(4, receipt(4));
    const delta = await run();
    expect(delta.metric.fetchedTxCount).toBe(1);
    expect(delta.history).toHaveLength(4);
    expect(store.snapshot.state.headSignature).toBe(signature(4));
    const totals = aggregateCashflowsForPosition(delta.history.flatMap(row => row.events), context.positionMint, context.poolId);
    expect(totals.depositedA).toBe(10n);
  });

  it("resumes bounded initial backfill and traverses provider pagination", async () => {
    const store = new MemoryStore();
    const upstream = rpc([5, 4, 3, 2, 1], undefined, 2);
    const run = () => syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 2 });
    expect((await run()).truncated).toBe(true);
    expect(store.snapshot.state).toMatchObject({ headSignature: signature(5), backfillBefore: signature(4), complete: false });
    expect((await run()).truncated).toBe(true);
    expect(store.snapshot.state.backfillBefore).toBe(signature(2));
    const final = await run();
    expect(final.truncated).toBe(false);
    expect(final.history).toHaveLength(5);
    expect(upstream.parsed).toHaveBeenCalledTimes(5);
  });

  it("persists additions across budget limits without advancing past an absent boundary", async () => {
    const store = new MemoryStore();
    const upstream = rpc([1]);
    await syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 2 });
    upstream.ids.unshift(5, 4, 3, 2);
    for (const id of [5, 4, 3, 2]) upstream.txs.set(id, receipt(id));
    const run = () => syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 2 });
    expect((await run()).truncated).toBe(true);
    expect(store.snapshot.state.headSignature).toBe(signature(1));
    expect((await run()).truncated).toBe(false);
    expect(store.snapshot.state.headSignature).toBe(signature(5));
    expect(upstream.parsed).toHaveBeenCalledTimes(5);
  });

  it("keeps null transactions pending and repairs them without duplicating events", async () => {
    const store = new MemoryStore();
    const upstream = rpc([3, 2, 1]);
    upstream.txs.delete(2);
    const run = () => syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 100 });
    expect((await run()).truncated).toBe(true);
    expect(store.snapshot.state.headSignature).toBeNull();
    expect(store.snapshot.transactions.find(row => row.signature === signature(2))?.status).toBe("pending");
    upstream.txs.set(2, receipt(2));
    expect((await run()).truncated).toBe(false);
    expect(store.snapshot.transactions).toHaveLength(3);
    expect(upstream.parsed).toHaveBeenCalledTimes(4);
  });

  it("preserves known complete state but marks the current delta incomplete on a null receipt", async () => {
    const store = new MemoryStore();
    const upstream = rpc([1]);
    const run = () => syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 100 });
    await run();
    upstream.ids.unshift(2);
    const current = await run();
    expect(current.truncated).toBe(true);
    expect(store.snapshot.state).toMatchObject({ complete: true, headSignature: signature(1) });
    expect(current.history).toHaveLength(1);
  });

  it("does not move a resumed backfill cursor past an unavailable receipt", async () => {
    const store = new MemoryStore();
    const upstream = rpc([5, 4, 3, 2, 1]);
    const run = () => syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 2 });
    await run();
    expect(store.snapshot.state.backfillBefore).toBe(signature(4));
    upstream.txs.delete(3);
    const incomplete = await run();
    expect(incomplete.truncated).toBe(true);
    expect(store.snapshot.state.backfillBefore).toBe(signature(4));
    expect(upstream.parsed).toHaveBeenCalledTimes(4);
    upstream.txs.set(3, receipt(3));
    expect((await run()).truncated).toBe(false);
    expect(store.snapshot.state.complete).toBe(true);
    expect(upstream.parsed).toHaveBeenCalledTimes(6);
  });

  it("cannot treat unavailable log receipts as an empty successful cashflow", async () => {
    const store = new MemoryStore();
    const upstream = rpc([1]);
    const run = () => syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 100 });
    await run();
    upstream.ids.unshift(2);
    const tx = receipt(2);
    tx.meta!.logMessages = null;
    upstream.txs.set(2, tx);
    expect((await run()).truncated).toBe(true);
    expect(store.snapshot.state.headSignature).toBe(signature(1));
    expect(store.snapshot.transactions.find(row => row.signature === signature(2))?.status).toBe("pending");
  });

  it("requires an opening event even on a short or empty provider page", async () => {
    const store = new MemoryStore();
    const upstream = rpc([3, 2], undefined, 1);
    const result = await syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 100 });
    expect(result.truncated).toBe(true);
    expect(store.snapshot.state.complete).toBe(false);
    expect(upstream.signatures).toHaveBeenCalledTimes(3);
  });

  it("does not advance a complete head when the provider loses its old boundary", async () => {
    const store = new MemoryStore();
    const upstream = rpc([1]);
    const run = () => syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 100 });
    await run();
    upstream.ids.splice(0, 1, 2);
    upstream.txs.set(2, receipt(2));
    expect((await run()).truncated).toBe(true);
    expect(store.snapshot.state.headSignature).toBe(signature(1));
  });

  it("treats failed transactions as terminal, skips their details and cashflows", async () => {
    const store = new MemoryStore();
    const upstream = rpc([2, 1]);
    const list = upstream.signatures;
    const base = list.getMockImplementation()!;
    list.mockImplementation(async (...args) => (await base(...args)).map(info => ({ ...info,
      err: info.signature === signature(2) ? { InstructionError: [0, "failed"] } : null })));
    const result = await syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 100 });
    expect(result.truncated).toBe(false);
    expect(result.history).toHaveLength(1);
    expect(upstream.parsed).toHaveBeenCalledTimes(1);
    expect(store.snapshot.transactions.find(row => row.signature === signature(2))?.status).toBe("failed");
  });

  it("deduplicates repeated signatures and keeps distinct signatures in the same slot", async () => {
    const store = new MemoryStore();
    const upstream = rpc([3, 3, 2, 1]);
    const base = upstream.signatures.getMockImplementation()!;
    upstream.signatures.mockImplementation(async (...args) => (await base(...args)).map(info => ({ ...info, slot: 42 })));
    for (const tx of upstream.txs.values()) tx.slot = 42;
    const result = await syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 100 });
    expect(result.truncated).toBe(false);
    expect(result.history).toHaveLength(3);
    expect(upstream.parsed).toHaveBeenCalledTimes(3);
  });

  it("reparses JSON receipts after a parser-version bump without calling upstream details", async () => {
    const store = new MemoryStore();
    const upstream = rpc([2, 1]);
    const run = () => syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 100 });
    await run();
    for (const row of store.snapshot.transactions) { row.parserVersion = 0; row.events = []; }
    const result = await run();
    expect(result.history).toHaveLength(2);
    expect(result.metric.fetchedTxCount).toBe(0);
    expect(upstream.parsed).toHaveBeenCalledTimes(2);
  });

  it("retains unparseable truncated receipts for later reparse and holds checkpoints", async () => {
    const store = new MemoryStore();
    const upstream = rpc([2, 1]);
    const tx = upstream.txs.get(2)!;
    const data = Buffer.alloc(40);
    createHash("sha256").update("global:decrease_liquidity_v2").digest().subarray(0, 8).copy(data);
    data.writeBigUInt64LE(1n, 8);
    const accounts = Array.from({ length: 16 }, () => new PublicKey(key()));
    for (const [index, field] of [[2, "positionAccount"], [3, "poolId"], [5, "vaultA"], [6, "vaultB"], [14, "mintA"], [15, "mintB"]] as const)
      accounts[index] = new PublicKey(context[field]);
    tx.transaction.message.instructions.push({ programId: CLMM_PROGRAM_ID, accounts, data: bs58.encode(data) });
    tx.meta!.logMessages = ["Log truncated"];
    const run = () => syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 100 });
    expect((await run()).truncated).toBe(true);
    expect(store.snapshot.state.headSignature).toBeNull();
    const pending = store.snapshot.transactions.find(row => row.signature === signature(2))!;
    expect(pending.status).toBe("pending");
    expect(pending.receipt).not.toBeNull();
    expect((await run()).truncated).toBe(true);
    expect(upstream.parsed).toHaveBeenCalledTimes(2);
  });

  it("prefers reliable fallback signature listing and retries null primary details", async () => {
    const store = new MemoryStore();
    const primary = rpc([1]);
    primary.txs.clear();
    const fallback = rpc([1]);
    const result = await syncPositionHistory({ context, store, connection: primary.connection,
      fallbackConnection: fallback.connection, maxSignatures: 100 });
    expect(primary.signatures).not.toHaveBeenCalled();
    expect(fallback.signatures).toHaveBeenCalled();
    expect(result.metric.defaultTxCount).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("returns cached incomplete results during an active lease and releases on RPC errors", async () => {
    const store = new MemoryStore();
    const upstream = rpc([1]);
    const run = () => syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 100 });
    await run();
    store.locked = true;
    expect((await run()).truncated).toBe(true);
    expect(upstream.signatures).toHaveBeenCalledTimes(1);
    store.locked = false;
    upstream.signatures.mockRejectedValue(new Error("provider unavailable"));
    await expect(run()).rejects.toThrow("provider unavailable");
    expect(store.released).toBe(2);
    expect(store.snapshot.state.complete).toBe(true);
  });

  it("does not discard a committed result or mask upstream errors when release fails", async () => {
    const store = new MemoryStore();
    const request = store.request.bind(store);
    store.request = async input => {
      if (input.op === "release") throw new Error("release offline");
      return request(input);
    };
    const upstream = rpc([1]);
    const run = () => syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 100 });
    expect((await run()).truncated).toBe(false);
    upstream.signatures.mockRejectedValue(new Error("listing offline"));
    await expect(run()).rejects.toThrow("listing offline");
  });
  it("finishes a delta backlog larger than the old scan window with a one-detail budget", async () => {
    const store = new MemoryStore();
    const upstream = rpc([1]);
    const run = () => syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 1 });
    await run();
    const added = Array.from({ length: 20 }, (_, i) => 21 - i);
    upstream.ids.unshift(...added);
    for (const id of added) upstream.txs.set(id, receipt(id));
    for (let i = 0; i < 19; i++) expect((await run()).truncated).toBe(true);
    expect((await run()).truncated).toBe(false);
    expect(store.snapshot.state.headSignature).toBe(signature(21));
    expect(upstream.parsed).toHaveBeenCalledTimes(21);
  });

  it("uses fallback for a primary receipt with unavailable logs or mismatched identity", async () => {
    for (const failure of ["logs", "signature", "slot"] as const) {
      const store = new MemoryStore();
      const primary = rpc([1]);
      const fallback = rpc([1]);
      const tx = primary.txs.get(1)!;
      if (failure === "logs") tx.meta!.logMessages = null;
      if (failure === "signature") tx.transaction.signatures[0] = signature(2);
      if (failure === "slot") tx.slot = 2;
      const result = await syncPositionHistory({ context, store, connection: primary.connection,
        fallbackConnection: fallback.connection, maxSignatures: 100 });
      expect(result.truncated).toBe(false);
      expect(fallback.parsed).toHaveBeenCalledTimes(1);
      expect(result.history[0]?.signature).toBe(signature(1));
    }
  });

  it("does not skip parsing when primary and fallback are the same connection", async () => {
    const store = new MemoryStore();
    const upstream = rpc([1]);
    const result = await syncPositionHistory({ context, store, connection: upstream.connection,
      fallbackConnection: upstream.connection, maxSignatures: 100 });
    expect(result.truncated).toBe(false);
    expect(upstream.parsed).toHaveBeenCalledTimes(1);
  });

  it("ignores another position opening in the same pool instead of sealing this history", async () => {
    const store = new MemoryStore();
    const upstream = rpc([3, 2, 1]);
    const unrelated = receipt(2, "open");
    const instruction = unrelated.transaction.message.instructions[0]!;
    if (!("accounts" in instruction)) throw new Error("Expected opening instruction");
    instruction.accounts[2] = new PublicKey(key());
    instruction.accounts[8] = new PublicKey(key());
    upstream.txs.set(2, unrelated);
    const result = await syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 100 });
    expect(result.truncated).toBe(false);
    expect(result.history.filter(row => row.events.some(event => event.kind === "open"))).toHaveLength(1);
    expect(result.history.some(row => row.signature === signature(2))).toBe(false);
  });

  it("does not require a pre-creation PDA receipt after the matched opening", async () => {
    const store = new MemoryStore();
    const upstream = rpc([2, 1, 0]);
    upstream.txs.delete(0);
    const result = await syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 100 });
    expect(result.truncated).toBe(false);
    expect(store.snapshot.transactions).toHaveLength(2);
    expect(store.snapshot.state.backfillBefore).toBe(signature(1));
  });

  it("resumes a delta scan when the provider returns short pages", async () => {
    const store = new MemoryStore();
    const upstream = rpc([1], undefined, 1);
    const run = () => syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 100 });
    await run();
    for (let id = 2; id <= 30; id++) { upstream.ids.unshift(id); upstream.txs.set(id, receipt(id)); }
    let result = await run();
    expect(store.snapshot.state.deltaBefore).not.toBeNull();
    for (let i = 0; i < 10 && result.truncated; i++) result = await run();
    expect(result.truncated).toBe(false);
    expect(store.snapshot.state).toMatchObject({ headSignature: signature(30), deltaBefore: null, deltaHead: null });
    expect(upstream.parsed).toHaveBeenCalledTimes(30);
  });

  it("keeps a resumed delta incomplete if newer operations arrive during its loading", async () => {
    const store = new MemoryStore();
    const upstream = rpc([1]);
    const run = () => syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 1 });
    await run();
    upstream.ids.unshift(3, 2);
    upstream.txs.set(2, receipt(2)); upstream.txs.set(3, receipt(3));
    expect((await run()).truncated).toBe(true);
    upstream.ids.unshift(4); upstream.txs.set(4, receipt(4));
    const previousWindow = await run();
    expect(previousWindow.truncated).toBe(true);
    expect(previousWindow.metric.canContinue).toBe(true);
    expect(store.snapshot.state.headSignature).toBe(signature(3));
    expect((await run()).truncated).toBe(false);
    expect(store.snapshot.state.headSignature).toBe(signature(4));
  });

  it("marks already-retained pre-creation pending rows irrelevant after recovering the opening", async () => {
    const store = new MemoryStore();
    const upstream = rpc([3, 2, 1]);
    upstream.txs.delete(2); upstream.txs.delete(1);
    const run = () => syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 100 });
    expect((await run()).truncated).toBe(true);
    upstream.txs.set(2, receipt(2, "open"));
    expect((await run()).truncated).toBe(false);
    expect(store.snapshot.transactions.find(row => row.signature === signature(1))?.status).toBe("ignored");
    expect(store.snapshot.state.complete).toBe(true);
  });

  it("repairs the opening before older missing PDA receipts with a one-detail budget", async () => {
    const store = new MemoryStore();
    const upstream = rpc([3, 2, 1]);
    upstream.txs.delete(2); upstream.txs.delete(1);
    await syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 100 });
    upstream.txs.set(2, receipt(2, "open"));
    const recovered = await syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 1 });
    expect(recovered.truncated).toBe(false);
    expect(store.snapshot.transactions.find(row => row.signature === signature(1))?.status).toBe("ignored");
    expect(recovered.metric.fetchedTxCount).toBe(1);
  });

  it("normalizes 499 retained precreation rows plus an opening repair and new trade in bounded commits", async () => {
    const store = new MemoryStore();
    const ids = Array.from({ length: 500 }, (_, index) => 500 - index);
    const txs = new Map(ids.filter(id => id !== 500).map(id => {
      const tx = receipt(id);
      tx.meta!.logMessages = ["Program log: prefunding"];
      return [id, tx] as const;
    }));
    const upstream = rpc(ids, txs);
    const initial = await syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 500 });
    expect(initial.truncated).toBe(true);
    expect(store.snapshot.transactions).toHaveLength(500);
    expect(store.commitSizes).toEqual([500]);

    upstream.txs.set(500, receipt(500, "open"));
    upstream.ids.unshift(501);
    upstream.txs.set(501, receipt(501));
    const run = () => syncPositionHistory({ context, store, connection: upstream.connection, maxSignatures: 100 });
    const firstRepair = await run();
    expect(firstRepair.truncated).toBe(true);
    expect(firstRepair.metric.canContinue).toBe(true);
    expect(store.snapshot.state).toMatchObject({ headSignature: null, complete: false });
    expect(store.commitSizes).toEqual([500, 500]);

    const finished = await run();
    expect(finished.truncated).toBe(false);
    expect(finished.history).toHaveLength(2);
    expect(store.snapshot.state).toMatchObject({ headSignature: signature(501), complete: true });
    expect(store.snapshot.transactions.filter(row => row.status === "ignored")).toHaveLength(499);
    expect(store.commitSizes).toEqual([500, 500, 1]);
    expect(store.commitSizes.every(size => size <= 500)).toBe(true);
    expect(upstream.parsed).toHaveBeenCalledTimes(502);
  });

});

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { dexDescriptors } from "@/lib/dex/client";
import { raydiumCompoundPrepared } from "@/lib/test-support/raydium-compound-prepared";
import { compoundHistoryFixture } from "@/lib/test-support/compound-history-fixture";
import { BLOCKHASH, testKeypair } from "@/lib/test-support/send-fixtures";
import { TX_PREFLIGHT_POLICY, type TxWallet } from "@/lib/tx-pipeline";
import { compoundAttemptKey, loadCompoundAttempt } from "@sofinance/engine/compound-attempt";
import type { RowContext } from "@/lib/compound-all/runner";
import { compoundRaydiumPosition, compoundRegistryPosition, createCompoundAllExecutors, ROW_LOCKED, ROW_STILL_CONFIRMING } from "./compound-all-executors";
import { beginPositionOp } from "../../unified-positions/position-op-lock";

const positionMint = testKeypair(80).publicKey.toBase58();
let walletAddress: string;
let prepares: number;
let preparedSeries: ReturnType<typeof raydiumCompoundPrepared>[];
let confirmReply: (signature: string) => unknown;
let requests: string[];
let stages: string[];
const context = (current = () => true): RowContext => ({ isCurrent: current, onStage: (stage) => { stages.push(stage); } });
const signingWallet = (): TxWallet & { sign: ReturnType<typeof vi.fn> } => {
  const sign = vi.fn(async (tx: VersionedTransaction) => { tx.sign([testKeypair(1)]); return tx; });
  return { address: walletAddress, signTransaction: sign, sign };
};
const noWait = { intervalMs: 1, maxWaitMs: 50, sleep: async () => {} };

beforeEach(() => {
  window.localStorage.clear();
  walletAddress = compoundHistoryFixture().wallet;
  prepares = 0; requests = []; stages = [];
  preparedSeries = [];
  confirmReply = (signature) => ({ signature, status: "success", chainStatus: "success", state: null });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requests.push(url);
    const body = JSON.parse(String(init?.body || "{}"));
    if (url === "/api/compound-prepare") {
      prepares++;
      const prepared = raydiumCompoundPrepared(positionMint);
      // Every prepare is fresh: a new blockhash, so a retry can never resend the old transaction.
      const tx = VersionedTransaction.deserialize(Buffer.from(prepared.unsignedTransaction, "base64"));
      const blockhash = bs58.encode(new Uint8Array(32).fill(7 + prepares));
      const fresh = new VersionedTransaction(new TransactionMessage({ payerKey: testKeypair(1).publicKey, recentBlockhash: blockhash,
        instructions: TransactionMessage.decompile(tx.message).instructions }).compileToV0Message());
      const next = { ...prepared, summary: { ...prepared.summary, blockhash }, unsignedTransaction: Buffer.from(fresh.serialize()).toString("base64") };
      preparedSeries.push(next);
      return Response.json(next);
    }
    if (url === "/api/tx-send") {
      const signed = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64"));
      return Response.json({ signature: bs58.encode(signed.signatures[0]!) });
    }
    if (url === "/api/tx-landed") return Response.json({ status: "not-landed" });
    if (url === "/api/compound-confirm") return Response.json(confirmReply(body.attempt.signature));
    return Response.json({ error: `unexpected ${url}` }, { status: 500 });
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Raydium row (extracted per-position compound)", () => {
  it("hands the wallet exactly the prepared bytes, saves the attempt and confirms", async () => {
    const wallet = signingWallet();
    const outcome = await compoundRaydiumPosition({ wallet, positionMint, storage: window.localStorage, context: context(), confirm: noWait });
    expect(outcome.status).toBe("done");
    const asked = wallet.sign.mock.calls[0]![0] as VersionedTransaction;
    expect(Buffer.from(asked.message.serialize()))
      .toEqual(Buffer.from(VersionedTransaction.deserialize(Buffer.from(preparedSeries[0]!.unsignedTransaction, "base64")).message.serialize()));
    const saved = loadCompoundAttempt(window.localStorage, walletAddress).attempt!;
    expect(outcome).toEqual({ status: "done", signature: saved.signature });
    expect(saved).toMatchObject({ kind: "compound", positionMint });
    expect(requests).toEqual(["/api/compound-prepare", "/api/tx-send", "/api/compound-confirm"]);
    expect(stages).toEqual(["preparing", "awaiting-wallet", "confirming", "confirming"]);
  });

  it("asks for no earlier harvest accounts (the final cleanup row handles them)", async () => {
    const fetchMock = vi.mocked(fetch);
    await compoundRaydiumPosition({ wallet: signingWallet(), positionMint, storage: window.localStorage, context: context(), confirm: noWait });
    const call = fetchMock.mock.calls.find(([url]) => url === "/api/compound-prepare")!;
    expect(JSON.parse(String(call[1]!.body))).toEqual({ wallet: walletAddress, positionMint, sourceSignatures: [] });
  });

  it("voids an unsigned prompt at the preflight deadline (55 s after prepare), and Retry prepares a fresh transaction", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    expect(TX_PREFLIGHT_POLICY).toMatchObject({ maxPromptMs: 60_000, blockhashSafeMs: 55_000 });
    const hanging = { address: walletAddress, signTransaction: vi.fn(() => new Promise<VersionedTransaction>(() => {})) };
    const waitVoided = vi.fn(async () => ({ status: "expired" as const }));
    const first = compoundRaydiumPosition({ wallet: hanging, positionMint, storage: window.localStorage, context: context(), waitVoided, confirm: noWait });
    await vi.advanceTimersByTimeAsync(54_000);
    expect(waitVoided).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    const outcome = await first;
    expect(outcome).toMatchObject({ status: "expired", retryable: true });
    expect(waitVoided).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(compoundAttemptKey(walletAddress))).toBeNull();
    vi.useRealTimers();
    // Retry: a new prepare with a new blockhash, and that is what the wallet signs.
    const wallet = signingWallet();
    const second = await compoundRaydiumPosition({ wallet, positionMint, storage: window.localStorage, context: context(), confirm: noWait });
    expect(second.status).toBe("done");
    expect(prepares).toBe(2);
    const asked = wallet.sign.mock.calls[0]![0] as VersionedTransaction;
    expect(asked.message.recentBlockhash).toBe(preparedSeries[1]!.summary.blockhash);
    expect(asked.message.recentBlockhash).not.toBe(preparedSeries[0]!.summary.blockhash);
  });

  it("maps a wallet rejection to a retryable rejected row with nothing saved", async () => {
    const wallet = { address: walletAddress, signTransaction: vi.fn(async () => { throw Object.assign(new Error("User rejected the request."), { code: 4001 }); }) };
    const outcome = await compoundRaydiumPosition({ wallet, positionMint, storage: window.localStorage, context: context(), confirm: noWait,
      waitVoided: async () => ({ status: "expired" }) });
    expect(outcome).toMatchObject({ status: "rejected", retryable: true });
    expect(window.localStorage.getItem(compoundAttemptKey(walletAddress))).toBeNull();
  });

  it("a chain failure is a retryable failed row; a compound still pending is not retryable", async () => {
    confirmReply = (signature) => ({ signature, status: "failed", chainStatus: "failed", state: null });
    expect(await compoundRaydiumPosition({ wallet: signingWallet(), positionMint, storage: window.localStorage, context: context(), confirm: noWait }))
      .toMatchObject({ status: "failed", retryable: true });
    confirmReply = (signature) => ({ signature, status: "pending", chainStatus: "pending", state: null });
    expect(await compoundRaydiumPosition({ wallet: signingWallet(), positionMint, storage: window.localStorage, context: context(), confirm: noWait }))
      .toEqual({ status: "failed", error: ROW_STILL_CONFIRMING, retryable: false });
  });

  it("a cancel after prepare stops before the wallet is asked", async () => {
    const wallet = signingWallet();
    const outcome = await compoundRaydiumPosition({ wallet, positionMint, storage: window.localStorage, context: context(() => false), confirm: noWait });
    expect(outcome).toMatchObject({ status: "failed", notSigned: true });
    expect(wallet.sign).not.toHaveBeenCalled();
  });
});

describe("registry row (Meteora: runTx + dexTxAdapter('compound'))", () => {
  const descriptor = dexDescriptors.descriptorFor("meteora-dlmm")!;
  const key = "meteora-dlmm:met1" as const;
  function stepResponse() {
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: testKeypair(1).publicKey, recentBlockhash: BLOCKHASH, instructions: [] }).compileToV0Message());
    return { step: 1, of: 1, done: true, label: "Claim the position's fees and add them back into it.",
      prepared: { kind: "solana-tx", transaction: Buffer.from(tx.serialize()).toString("base64"), lastValidBlockHeight: 150, positionMint: "met1",
        sendPermit: "s", landedPermit: "l" } };
  }
  beforeEach(() => {
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (url === "/api/dex/meteora-dlmm/compound") { requests.push(String(url)); return Response.json(stepResponse()); }
      return base(url, init);
    });
  });
  it("prepares through the shared DEX route, sends, and waits for Solana", async () => {
    const wallet = signingWallet();
    const poll = vi.fn(async () => "confirmed" as const);
    const outcome = await compoundRegistryPosition({ wallet, descriptor, positionKey: key, storage: window.localStorage, context: context(),
      simulate: async () => ({ ok: true }), poll });
    expect(outcome.status).toBe("done");
    expect(requests).toEqual(["/api/dex/meteora-dlmm/compound", "/api/tx-send"]);
    expect(poll).toHaveBeenCalledWith(expect.objectContaining({ lastValidBlockHeight: 150 }));
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls.find(([url]) => url === "/api/dex/meteora-dlmm/compound")![1]!.body));
    expect(body).toMatchObject({ owner: walletAddress, positionKey: key, step: 1, priorSignatures: [] });
  });
  it.each([["expired", "expired"], ["failed", "failed"]] as const)("a %s chain result is a retryable %s row", async (chain, status) => {
    const outcome = await compoundRegistryPosition({ wallet: signingWallet(), descriptor, positionKey: key, storage: window.localStorage, context: context(),
      simulate: async () => ({ ok: true }), poll: async () => chain });
    expect(outcome).toMatchObject({ status, retryable: true });
  });
  it("a rejection is a retryable rejected row", async () => {
    const wallet = { address: walletAddress, signTransaction: vi.fn(async () => { throw Object.assign(new Error("User rejected the request."), { code: 4001 }); }) };
    const outcome = await compoundRegistryPosition({ wallet, descriptor, positionKey: "meteora-dlmm:met2", storage: window.localStorage, context: context(),
      simulate: async () => ({ ok: true }), poll: async () => "confirmed" });
    expect(outcome).toMatchObject({ status: "rejected", retryable: true });
  });
});

describe("executors", () => {
  it("refuses a row whose position already has an op in flight", async () => {
    const release = beginPositionOp("meteora-dlmm:busy")!;
    const deps = createCompoundAllExecutors({ wallet: signingWallet(), storage: window.localStorage, descriptorFor: (dex) => dexDescriptors.descriptorFor(dex),
      cleanupBatch: async () => ({ status: "done" }) });
    const row = { key: "meteora-dlmm:busy" as const, dex: "meteora-dlmm" as const, flow: "registry" as const, positionId: "busy", partToWallet: false, selected: true, status: "preparing" as const, attempts: 1 };
    expect(await deps.runRow(row, context())).toEqual({ status: "failed", error: ROW_LOCKED, retryable: true, notSigned: true });
    release();
  });
  it("refuses a row whose flow is not what the registry says for its DEX", async () => {
    const deps = createCompoundAllExecutors({ wallet: signingWallet(), storage: window.localStorage, descriptorFor: (dex) => dexDescriptors.descriptorFor(dex),
      cleanupBatch: async () => ({ status: "done" }) });
    const base = { selected: true, status: "preparing" as const, attempts: 1, partToWallet: false };
    for (const row of [{ ...base, key: "meteora-dlmm:m" as const, dex: "meteora-dlmm" as const, flow: "native-harvest" as const, positionId: "m" },
      { ...base, key: "orca-whirlpool:o" as const, dex: "orca-whirlpool" as const, flow: "registry" as const, positionId: "o" }]) {
      expect(await deps.runRow(row, context())).toMatchObject({ status: "failed", retryable: false, notSigned: true });
    }
    expect(requests).toEqual([]);
  });
  it("the cleanup row hands the existing cleanup batch only this run's saved receipts", async () => {
    const fixture = compoundHistoryFixture();
    const other = { ...fixture.attempt, signature: bs58.encode(new Uint8Array(64).fill(3)),
      summary: { ...fixture.attempt.summary, compoundAccounts: fixture.attempt.summary.compoundAccounts.map((account, i) => ({ ...account, address: testKeypair(40 + i).publicKey.toBase58() })) as typeof fixture.attempt.summary.compoundAccounts } };
    const { persistCompoundAttempt } = await import("@sofinance/engine/compound-attempt");
    persistCompoundAttempt(window.localStorage, fixture.attempt); persistCompoundAttempt(window.localStorage, other);
    const cleanupBatch = vi.fn(async () => ({ status: "done" as const }));
    const deps = createCompoundAllExecutors({ wallet: signingWallet(), storage: window.localStorage, descriptorFor: () => null, cleanupBatch });
    expect(await deps.runCleanup([fixture.attempt.signature], { onStage: () => {} })).toEqual({ status: "done" });
    expect(cleanupBatch).toHaveBeenCalledTimes(1);
    expect((cleanupBatch.mock.calls[0] as unknown as [{ sourceSignature: string }[]])[0].map((r) => r.sourceSignature)).toEqual([fixture.attempt.signature]);
    cleanupBatch.mockClear();
    expect(await deps.runCleanup(["unknown-signature"], { onStage: () => {} })).toEqual({ status: "done" });
    expect(cleanupBatch).not.toHaveBeenCalled();
  });
});

describe("rowFailureOf", () => {
  it("maps every pipeline failure kind to a row outcome", async () => {
    const { rowFailureOf } = await import("./compound-all-executors");
    const { TxRunError, TxNotLandedError } = await import("@/lib/tx-pipeline");
    const rejection = Object.assign(new Error("User rejected the request."), { code: 4001 });
    expect(rowFailureOf(new TxRunError("rejected", "m", false, null), false)).toMatchObject({ status: "rejected", retryable: true });
    expect(rowFailureOf(new TxRunError("not-sent", "m", false, new TxNotLandedError(true, rejection)), false)).toMatchObject({ status: "rejected", retryable: true });
    expect(rowFailureOf(new TxRunError("expired", "m", true, null), false)).toMatchObject({ status: "expired", retryable: true });
    expect(rowFailureOf(new TxRunError("not-sent", "m", true, null), false)).toMatchObject({ status: "failed", retryable: true, notSigned: true });
    expect(rowFailureOf(new TxRunError("failed", "m", true, null), false)).toMatchObject({ status: "failed", retryable: true });
    expect(rowFailureOf(new TxRunError("unknown", "m", false, null), false)).toMatchObject({ status: "failed", retryable: false });
    expect(rowFailureOf(new Error("prepare broke"), true)).toMatchObject({ status: "failed", retryable: true, notSigned: true });
    expect(rowFailureOf(new Error("after send"), false)).toMatchObject({ status: "failed", retryable: false });
  });
});

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { buildTransaction, testKeypair } from "@/lib/test-support/send-fixtures";

const sentry = vi.hoisted(() => ({ capture: vi.fn(), landed: vi.fn(), preflight: vi.fn() }));
vi.mock("@/lib/sentry/client-tx", () => ({ captureTxClientFailure: sentry.capture, captureTxWalletErrorLanded: sentry.landed, captureTxPreflightEvent: sentry.preflight }));
vi.mock("@/lib/position-history-refresh", () => ({ notifyPositionHistoryChange: vi.fn() }));

import {
  findTxNotice, noticeIdFor, resetCancelChecks, resetTxNotices, runTx, STALE_QUOTE_MESSAGE, TX_PREFLIGHT_POLICY, TX_PROMPT_EXPIRED_MESSAGE,
  TX_WAITING_PREVIOUS_EXPIRY_COPY, VOIDED_POLL_INTERVAL_MS, WALLET_ERROR_CATEGORIES, waitForVoidedExpiry, walletErrorCategory,
  type PreflightSimulation, type PreparedTx, type SimulatePrepared, type TxAdapter, type TxStage, type TxWallet, type VoidedOutcome, type WaitVoided,
} from "./index";
import { SIM_SLIPPAGE_CAUSE, plainSimulationCause } from "@/lib/tx-simulate/cause";

const payer = testKeypair(21);
const WALLET = payer.publicKey.toBase58();
const SIG = bs58.encode(new Uint8Array(64).fill(5));
const prepared = (n: number): PreparedTx & { n: number } => ({ n, transaction: buildTransaction({ payer, signWith: [] }), lastValidBlockHeight: 100 + n, landedPermit: "a".repeat(64), dispose: vi.fn() });

function adapterWith(preflight = true) {
  let n = 0;
  const made: (PreparedTx & { n: number })[] = [];
  const prepare = vi.fn(async () => { const p = prepared(++n); made.push(p); return p; });
  const adapter: TxAdapter<unknown, PreparedTx & { n: number }> = { flow: "add", successTitle: "Liquidity added", prepare, ...(preflight ? { preflight: TX_PREFLIGHT_POLICY } : {}) };
  return { adapter, prepare, made };
}
const sims = (...results: PreflightSimulation[]) => vi.fn<SimulatePrepared>(async () => results.shift() ?? { ok: true });
function wallet(signAndSend: TxWallet["signAndSendTransaction"] = vi.fn(async () => SIG)): TxWallet {
  return { address: WALLET, signTransaction: vi.fn(), signAndSendTransaction: signAndSend };
}
/**
 * Every preflight count carries only flow / event / attempt / wallet error code / a fixed message category: no
 * address, signature, blockhash, amount or raw wallet message.
 */
const PII = [WALLET, SIG, "1.2345", "User rejected the request"];
function expectNoPersonalData() {
  for (const call of sentry.preflight.mock.calls) {
    const text = JSON.stringify(call);
    for (const secret of PII) expect(text).not.toContain(secret);
    const detail = (call[2] ?? {}) as Record<string, unknown>;
    expect(Object.keys(detail).every((key) => ["attempt", "walletErrorCode", "walletErrorCategory"].includes(key))).toBe(true);
    if ("walletErrorCode" in detail) expect(typeof detail.walletErrorCode === "number" || detail.walletErrorCode === "none").toBe(true);
    if ("walletErrorCategory" in detail) expect(WALLET_ERROR_CATEGORIES).toContain(detail.walletErrorCategory);
  }
}

beforeEach(() => { resetTxNotices(); resetCancelChecks(); sentry.preflight.mockReset(); sentry.capture.mockReset(); });
afterEach(() => { vi.useRealTimers(); expectNoPersonalData(); });

describe("pre-wallet guard (a): server simulation", () => {
  it("a failed simulation re-quotes and re-prepares once, then sends the fresh transaction", async () => {
    const { adapter, prepare, made } = adapterWith();
    const simulate = sims({ ok: false, cause: SIM_SLIPPAGE_CAUSE }, { ok: true });
    const send = vi.fn(async () => SIG);
    const result = await runTx(adapter, {}, { wallet: wallet(send), simulate });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(simulate).toHaveBeenCalledTimes(2);
    expect(simulate.mock.calls[1]![1]).toEqual({ landedPermit: "a".repeat(64), lastValidBlockHeight: 102 });
    expect(result.prepared.n).toBe(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(made[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(sentry.preflight).toHaveBeenCalledWith("add", "sim-failed", { attempt: 1 });
  });
  it("a second failed simulation stops before the wallet with the real cause in plain words", async () => {
    const { adapter, prepare } = adapterWith();
    const send = vi.fn(async () => SIG);
    const error = await runTx(adapter, {}, { wallet: wallet(send), simulate: sims({ ok: false, cause: "first" }, { ok: false, cause: SIM_SLIPPAGE_CAUSE }) }).catch((e) => e);
    expect(error).toMatchObject({ kind: "not-sent", message: SIM_SLIPPAGE_CAUSE, retryable: true });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
    expect(sentry.preflight.mock.calls.map((c) => c.slice(1))).toEqual([["sim-failed", { attempt: 1 }], ["sim-failed", { attempt: 2 }]]);
  });
  it("an unavailable simulation (public RPC busy) is counted but does not block", async () => {
    const { adapter, prepare } = adapterWith();
    const send = vi.fn(async () => SIG);
    await runTx(adapter, {}, { wallet: wallet(send), simulate: sims({ ok: null, unavailable: true }) });
    expect(prepare).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1);
    expect(sentry.preflight).toHaveBeenCalledWith("add", "sim-unavailable", { attempt: 1 });
  });
  it("flows without the policy (Raydium, legacy panels, MCP, /sign) never simulate or time out", async () => {
    const { adapter } = adapterWith(false);
    const simulate = sims({ ok: false, cause: "x" });
    await runTx(adapter, {}, { wallet: wallet(), simulate });
    expect(simulate).not.toHaveBeenCalled(); expect(sentry.preflight).not.toHaveBeenCalled();
  });
  it("names known causes in plain words, and otherwise the failing instruction without JSON", () => {
    expect(plainSimulationCause({ InstructionError: [1, { Custom: 6001 }] }, ["Program log: Error: SlippageToleranceExceeded"])).toBe(SIM_SLIPPAGE_CAUSE);
    expect(plainSimulationCause("BlockhashNotFound", null)).toMatch(/blockhash expired/);
    const other = plainSimulationCause({ InstructionError: [3, { Custom: 9999 }] }, ["Program log: AnchorError occurred. Error Code: BinArrayNotFound."]);
    expect(other).toMatch(/^Solana's simulation of this transaction failed at instruction 4 \(.*BinArrayNotFound/);
    expect(other).not.toMatch(/[{}"]/);
  });
});

describe("pre-wallet guard (d): quote freshness", () => {
  it("a slow simulation does not count toward the quote's age (no extra re-prepare)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { adapter, prepare } = adapterWith();
    // The public RPC takes longer than the whole quote limit to answer.
    const simulate = vi.fn<SimulatePrepared>(async () => { vi.setSystemTime(Date.now() + TX_PREFLIGHT_POLICY.maxQuoteAgeMs + 5_000); return { ok: true }; });
    const send = vi.fn(async () => SIG);
    const result = await runTx(adapter, {}, { wallet: wallet(send), simulate });
    expect(prepare).toHaveBeenCalledTimes(1); expect(result.prepared.n).toBe(1); expect(send).toHaveBeenCalledTimes(1);
    expect(sentry.preflight).not.toHaveBeenCalledWith("add", "stale-quote", expect.anything());
  });
  it("a quote older than the limit is re-quoted before the wallet is asked", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { adapter, prepare } = adapterWith();
    // Prepare itself (the quote) took longer than the limit; the simulation was instant.
    let prepares = 0;
    const slowPrepare = adapter.prepare;
    adapter.prepare = vi.fn(async (...args: Parameters<typeof slowPrepare>) => {
      const made = await slowPrepare(...args);
      if (++prepares === 1) vi.setSystemTime(Date.now() + TX_PREFLIGHT_POLICY.maxQuoteAgeMs + 1);
      return made;
    });
    const send = vi.fn(async () => SIG);
    const result = await runTx(adapter, {}, { wallet: wallet(send), simulate: sims() });
    expect(prepare).toHaveBeenCalledTimes(2); expect(result.prepared.n).toBe(2); expect(send).toHaveBeenCalledTimes(1);
    expect(sentry.preflight).toHaveBeenCalledWith("add", "stale-quote", { attempt: 1 });
  });
  it("stops with a plain message when even the fresh quote is too old", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { adapter } = adapterWith();
    const slowPrepare = adapter.prepare;
    adapter.prepare = vi.fn(async (...args: Parameters<typeof slowPrepare>) => {
      const made = await slowPrepare(...args);
      vi.setSystemTime(Date.now() + TX_PREFLIGHT_POLICY.maxQuoteAgeMs + 1);
      return made;
    });
    const send = vi.fn(async () => SIG);
    await expect(runTx(adapter, {}, { wallet: wallet(send), simulate: sims() })).rejects.toMatchObject({ kind: "not-sent", message: STALE_QUOTE_MESSAGE });
    expect(send).not.toHaveBeenCalled();
  });
});

/** A controllable expiry wait: resolves when the test says the old transaction landed or expired. */
function voidedWait() {
  let settle: (outcome: VoidedOutcome) => void = () => undefined;
  const calls: Parameters<WaitVoided>[1][] = [];
  const wait = vi.fn<WaitVoided>((_tx, check) => { calls.push(check); return new Promise((resolve) => { settle = resolve; }); });
  return { wait, calls, settle: (outcome: VoidedOutcome) => settle(outcome) };
}

describe("pre-wallet guard (b): prompt expiry, no double-landing", () => {
  it("(i) the voided transaction lands during the wait: the step counts as done and is never resent", async () => {
    vi.useFakeTimers();
    const { adapter, prepare } = adapterWith();
    let resolveLate: (signature: string) => void = () => undefined;
    const send = vi.fn(() => new Promise<string>((resolve) => { resolveLate = resolve; }));
    const retry = vi.fn();
    const stages: TxStage[] = [];
    const voided = voidedWait();
    const run = runTx(adapter, {}, { wallet: wallet(send), simulate: sims(), retry, waitVoided: voided.wait, onStage: (stage) => stages.push(stage) });
    await vi.advanceTimersByTimeAsync(TX_PREFLIGHT_POLICY.blockhashSafeMs + 1);
    expect(stages.at(-1)).toBe("expiring");
    expect(sentry.preflight).toHaveBeenCalledWith("add", "prompt-expired");
    // Still waiting: no Try again offered yet (runTx has not failed), nothing new prepared or sent.
    expect(voided.wait).toHaveBeenCalledTimes(1);
    expect(voided.calls[0]).toMatchObject({ lastValidBlockHeight: 101, landedPermit: "a".repeat(64) });
    // The wallet's signAndSend resolves late: the wait sees its signature (getSignatureStatuses on the server).
    resolveLate(SIG);
    await vi.advanceTimersByTimeAsync(0);
    expect(voided.calls[0]!.signature()).toBe(SIG);
    voided.settle({ status: "landed", signature: SIG });
    const result = await run;
    expect(result).toMatchObject({ signature: SIG, via: "wallet" });
    expect(stages.at(-1)).toBe("confirming");
    expect(findTxNotice(noticeIdFor(SIG))?.state).toBe("loading");
    expect(sentry.preflight).toHaveBeenCalledWith("add", "void-landed");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(prepare).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1); expect(retry).not.toHaveBeenCalled();
  });
  it("(ii) the voided transaction expires: only then does Try again appear, and it re-prepares with no automatic resend", async () => {
    vi.useFakeTimers();
    const { adapter, prepare } = adapterWith();
    const send = vi.fn(() => new Promise<string>(() => undefined));
    const retry = vi.fn();
    const stages: [TxStage, number | undefined][] = [];
    const voided = voidedWait();
    let settled = false;
    const run = runTx(adapter, {}, { wallet: wallet(send), simulate: sims(), retry, waitVoided: voided.wait,
      onStage: (stage, detail) => stages.push([stage, detail?.secondsLeft]) }).catch((e) => e).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(TX_PREFLIGHT_POLICY.blockhashSafeMs + 1);
    voided.calls[0]!.onWaiting?.(12);
    expect(stages.at(-1)).toEqual(["expiring", 12]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false); // Try again stays disabled while the old blockhash could still land.
    voided.settle({ status: "expired" });
    const error = await run;
    expect(error).toMatchObject({ kind: "expired", message: TX_PROMPT_EXPIRED_MESSAGE, retryable: true });
    expect(error.message).not.toMatch(/try again/i); // The Try again link sits below the message, not in it.
    expect(sentry.preflight).toHaveBeenCalledWith("add", "void-expired");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(prepare).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1); expect(retry).not.toHaveBeenCalled();
    vi.useRealTimers();
    const again = await runTx(adapter, {}, { wallet: wallet(vi.fn(async () => SIG)), simulate: sims() });
    expect(prepare).toHaveBeenCalledTimes(2); expect(again.prepared.n).toBe(2);
  });
  it("cannot tell (no permit to ask with): never offers Try again as if it expired", async () => {
    vi.useFakeTimers();
    const { adapter } = adapterWith();
    const run = runTx(adapter, {}, { wallet: wallet(vi.fn(() => new Promise<string>(() => undefined))), simulate: sims(),
      waitVoided: async () => ({ status: "unknown" }) }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(TX_PREFLIGHT_POLICY.blockhashSafeMs + 1);
    expect(await run).toMatchObject({ kind: "unknown", retryable: false });
  });
  it("a sign-only wallet's late signature after the void is never relayed", async () => {
    vi.useFakeTimers();
    const { adapter } = adapterWith();
    let lateSign: (tx: never) => void = () => undefined;
    const sendRaw = vi.fn(async () => SIG);
    const signOnly: TxWallet = { address: WALLET, signTransaction: vi.fn(() => new Promise<never>((resolve) => { lateSign = resolve as never; })) };
    const run = runTx(adapter, {}, { wallet: signOnly, sendRaw, simulate: sims(), waitVoided: async () => ({ status: "expired" }) }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(TX_PREFLIGHT_POLICY.maxPromptMs + 1);
    expect(await run).toMatchObject({ kind: "expired", message: TX_PROMPT_EXPIRED_MESSAGE });
    lateSign({} as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(sendRaw).not.toHaveBeenCalled();
  });
  it("unmount clears the prompt deadline timer: no void, no expiry wait", async () => {
    vi.useFakeTimers();
    const { adapter } = adapterWith();
    const controller = new AbortController();
    const voided = voidedWait();
    let resolveLate: (signature: string) => void = () => undefined;
    const run = runTx(adapter, {}, { wallet: wallet(vi.fn(() => new Promise<string>((resolve) => { resolveLate = resolve; }))), simulate: sims(),
      waitVoided: voided.wait, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(1_000);
    const pending = vi.getTimerCount();
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBeLessThan(pending);
    await vi.advanceTimersByTimeAsync(TX_PREFLIGHT_POLICY.maxPromptMs + 1);
    expect(voided.wait).not.toHaveBeenCalled();
    resolveLate(SIG);
    expect((await run).signature).toBe(SIG);
  });
  it("shows the waiting copy, and the expired copy without a second Try again", () => {
    expect(TX_WAITING_PREVIOUS_EXPIRY_COPY).toBe("Waiting for the previous request to expire…");
    expect(TX_PROMPT_EXPIRED_MESSAGE).toBe("This request expired.");
  });
});

describe("pre-wallet guard (c): counts with no personal data", () => {
  it("counts a wallet rejection with the wallet's full error code and a message category, never the message", async () => {
    const { adapter } = adapterWith();
    const reject = vi.fn(async () => { throw Object.assign(new Error(`User rejected the request. ${WALLET} 1.2345 SOL`), { code: 4001 }); });
    await runTx(adapter, {}, { wallet: wallet(reject), simulate: sims(), findLanded: async () => ({ status: "not-landed" }) }).catch(() => null);
    expect(sentry.preflight).toHaveBeenCalledWith("add", "wallet-rejected", { walletErrorCode: 4001, walletErrorCategory: "user-rejected" });
  });
  it("reads a nested adapter code and reports 'none' when the wallet gave no code", async () => {
    const { adapter } = adapterWith();
    const nested = vi.fn(async () => { throw Object.assign(new Error("WalletSendTransactionError"), { error: { code: 5000, message: "rejected" } }); });
    await runTx(adapter, {}, { wallet: wallet(nested), simulate: sims(), findLanded: async () => ({ status: "not-landed" }) }).catch(() => null);
    expect(sentry.preflight).toHaveBeenCalledWith("add", "wallet-rejected", { walletErrorCode: 5000, walletErrorCategory: "user-rejected" });
    sentry.preflight.mockReset(); resetCancelChecks();
    const plain = vi.fn(async () => { throw new Error("User rejected the request."); });
    await runTx(adapter, {}, { wallet: wallet(plain), simulate: sims(), findLanded: async () => ({ status: "not-landed" }) }).catch(() => null);
    expect(sentry.preflight).toHaveBeenCalledWith("add", "wallet-rejected", { walletErrorCode: "none", walletErrorCategory: "user-rejected" });
  });
  it("classifies wallet messages into the fixed set only", () => {
    expect(walletErrorCategory(new Error("Failed to simulate transaction"))).toBe("simulation-failed");
    expect(walletErrorCategory(new Error("Blockhash not found"))).toBe("blockhash");
    expect(walletErrorCategory(new Error(`Insufficient funds for ${WALLET}`))).toBe("insufficient-funds");
    expect(walletErrorCategory(new Error("Request timed out"))).toBe("timeout");
    expect(walletErrorCategory(new Error("Wallet disconnected"))).toBe("disconnected");
    expect(walletErrorCategory(new Error(""))).toBe("empty");
    expect(walletErrorCategory(new Error(SIG))).toBe("other");
  });
});

describe("waitForVoidedExpiry (/api/tx-expiry polling)", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it("keeps waiting through pending and RPC trouble, sends the late signature, and stops at expired", async () => {
    vi.useFakeTimers();
    const answers = [{ status: 200, body: { status: "pending", blocksLeft: 25 } }, { status: 502, body: { error: "x" } }, { status: 200, body: { status: "expired" } }];
    const fetchMock = vi.fn(async () => { const next = answers.shift()!; return new Response(JSON.stringify(next.body), { status: next.status }); });
    vi.stubGlobal("fetch", fetchMock);
    const waiting = vi.fn();
    const late: { signature?: string } = {};
    const outcome = waitForVoidedExpiry(prepared(1).transaction, { landedPermit: "a".repeat(64), lastValidBlockHeight: 101, preparedAt: 1,
      signature: () => late.signature, onWaiting: waiting });
    await vi.advanceTimersByTimeAsync(0);
    expect(waiting).toHaveBeenCalledWith(10);
    late.signature = SIG;
    await vi.advanceTimersByTimeAsync(VOIDED_POLL_INTERVAL_MS * 2);
    expect(await outcome).toEqual({ status: "expired" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String((fetchMock.mock.calls[2] as unknown as [string, RequestInit])[1].body)).signature).toBe(SIG);
  });
  it("without a permit it cannot ask, so it never answers expired", async () => {
    expect(await waitForVoidedExpiry(prepared(1).transaction, { lastValidBlockHeight: 101, preparedAt: 1, signature: () => undefined })).toEqual({ status: "unknown" });
  });
});

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { buildTransaction, testKeypair } from "@/lib/test-support/send-fixtures";

const sentry = vi.hoisted(() => ({ capture: vi.fn(), landed: vi.fn(), preflight: vi.fn() }));
vi.mock("@/lib/sentry/client-tx", () => ({ captureTxClientFailure: sentry.capture, captureTxWalletErrorLanded: sentry.landed, captureTxPreflightEvent: sentry.preflight }));
vi.mock("@/lib/position-history-refresh", () => ({ notifyPositionHistoryChange: vi.fn() }));

import {
  findTxNotice, noticeIdFor, resetCancelChecks, resetTxNotices, runTx, STALE_QUOTE_MESSAGE, TX_PREFLIGHT_POLICY, TX_PROMPT_EXPIRED_MESSAGE,
  type PreflightSimulation, type PreparedTx, type SimulatePrepared, type TxAdapter, type TxWallet,
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
/** Every preflight count must carry only flow / event / attempt / wallet error code: no address, signature, blockhash. */
function expectNoPersonalData() {
  for (const call of sentry.preflight.mock.calls) {
    const text = JSON.stringify(call);
    expect(text).not.toContain(WALLET);
    expect(text).not.toContain(SIG);
    expect(Object.keys(call[2] ?? {}).every((key) => key === "attempt" || key === "walletErrorCode")).toBe(true);
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
  it("a quote older than the limit is re-quoted before the wallet is asked", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { adapter, prepare } = adapterWith();
    let calls = 0;
    const simulate = vi.fn<SimulatePrepared>(async () => { if (++calls === 1) vi.setSystemTime(Date.now() + TX_PREFLIGHT_POLICY.maxQuoteAgeMs + 1); return { ok: true }; });
    const send = vi.fn(async () => SIG);
    const result = await runTx(adapter, {}, { wallet: wallet(send), simulate });
    expect(prepare).toHaveBeenCalledTimes(2); expect(result.prepared.n).toBe(2); expect(send).toHaveBeenCalledTimes(1);
    expect(sentry.preflight).toHaveBeenCalledWith("add", "stale-quote", { attempt: 1 });
  });
  it("stops with a plain message when even the fresh quote is too old", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { adapter } = adapterWith();
    const simulate = vi.fn<SimulatePrepared>(async () => { vi.setSystemTime(Date.now() + TX_PREFLIGHT_POLICY.maxQuoteAgeMs + 1); return { ok: true }; });
    const send = vi.fn(async () => SIG);
    await expect(runTx(adapter, {}, { wallet: wallet(send), simulate })).rejects.toMatchObject({ kind: "not-sent", message: STALE_QUOTE_MESSAGE });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("pre-wallet guard (b): prompt expiry", () => {
  it("voids an unsigned prompt after the deadline; Try again re-prepares and nothing is resent automatically", async () => {
    vi.useFakeTimers();
    const { adapter, prepare } = adapterWith();
    let resolveLate: (signature: string) => void = () => undefined;
    const send = vi.fn(() => new Promise<string>((resolve) => { resolveLate = resolve; }));
    const retry = vi.fn();
    const run = runTx(adapter, {}, { wallet: wallet(send), simulate: sims(), retry }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(TX_PREFLIGHT_POLICY.blockhashSafeMs + 1);
    const error = await run;
    expect(error).toMatchObject({ kind: "expired", message: TX_PROMPT_EXPIRED_MESSAGE, retryable: true });
    expect(sentry.preflight).toHaveBeenCalledWith("add", "prompt-expired");
    expect(prepare).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(prepare).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1); expect(retry).not.toHaveBeenCalled();
    // The wallet broadcast it anyway after the void: tracked so a landing is never hidden, still never resent.
    resolveLate(SIG);
    await vi.advanceTimersByTimeAsync(0);
    expect(findTxNotice(noticeIdFor(SIG))?.state).toBe("loading");
    expect(send).toHaveBeenCalledTimes(1);
    // Try again = a new run: a fresh prepare and a new wallet request.
    vi.useRealTimers();
    const again = await runTx(adapter, {}, { wallet: wallet(vi.fn(async () => SIG)), simulate: sims() });
    expect(prepare).toHaveBeenCalledTimes(2); expect(again.prepared.n).toBe(2);
  });
  it("a sign-only wallet's late signature after the void is never relayed", async () => {
    vi.useFakeTimers();
    const { adapter } = adapterWith();
    let lateSign: (tx: never) => void = () => undefined;
    const sendRaw = vi.fn(async () => SIG);
    const signOnly: TxWallet = { address: WALLET, signTransaction: vi.fn(() => new Promise<never>((resolve) => { lateSign = resolve as never; })) };
    const run = runTx(adapter, {}, { wallet: signOnly, sendRaw, simulate: sims() }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(TX_PREFLIGHT_POLICY.maxPromptMs + 1);
    expect(await run).toMatchObject({ kind: "expired", message: TX_PROMPT_EXPIRED_MESSAGE });
    lateSign({} as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(sendRaw).not.toHaveBeenCalled();
  });
});

describe("pre-wallet guard (c): counts with no personal data", () => {
  it("counts a wallet rejection with only the flow and the wallet's error code", async () => {
    const { adapter } = adapterWith();
    const reject = vi.fn(async () => { throw Object.assign(new Error("User rejected the request."), { code: 4001 }); });
    await runTx(adapter, {}, { wallet: wallet(reject), simulate: sims(), findLanded: async () => ({ status: "not-landed" }) }).catch(() => null);
    expect(sentry.preflight).toHaveBeenCalledWith("add", "wallet-rejected", { walletErrorCode: 4001 });
  });
});

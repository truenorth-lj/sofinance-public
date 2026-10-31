// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { buildTransaction, testKeypair } from "@/lib/test-support/send-fixtures";

const sentry = vi.hoisted(() => ({ capture: vi.fn() }));
const history = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock("@/lib/sentry/client-tx", () => ({ captureTxClientFailure: sentry.capture }));
vi.mock("@/lib/position-history-refresh", () => ({ notifyPositionHistoryChange: history.notify }));

import {
  BALANCES_REFRESH_EVENT, canRetry, clearTxAttempt, findTxNotice, getTxNotices, loadTxAttempts, noticeIdFor, plainTxError,
  pollSignature, readSignatureStatus, relaySignedTransaction, RELAY_TIMEOUT_MS, reportTxFailure, resetTxNotices, runTx,
  saveTxAttempt, sendAndTrack, sendWithWallet, settleTxNotice, solscanTxUrl, trackTxSignature, txAttemptsKey, txFailureKind,
  TxNotSentError, TxRunError, TxSendUnknownError, watchTxNotice, type TxAdapter, type TxAttempt, type TxWallet,
} from "./index";
import { TX_EXPIRED_MESSAGE } from "@/lib/public-error";

const payer = testKeypair(11);
const cosigner = testKeypair(12);
const WALLET = payer.publicKey.toBase58();
const unsigned = (extra = false) => buildTransaction({ payer, extraSigners: extra ? [cosigner] : [], signWith: [] });
const copy = (tx: VersionedTransaction) => VersionedTransaction.deserialize(tx.serialize());
const sigOf = (tx: VersionedTransaction) => bs58.encode(tx.signatures[0]!);
const SIG = bs58.encode(new Uint8Array(64).fill(3));

function memoryStorage() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); }, map };
}
function signingWallet(options: { signAndSend?: boolean } = {}) {
  const signed: VersionedTransaction[] = [];
  const wallet: TxWallet & { signed: VersionedTransaction[] } = {
    address: WALLET, signed,
    signTransaction: vi.fn(async (tx: VersionedTransaction) => { const out = copy(tx); out.sign([payer]); signed.push(out); return out; }),
    ...(options.signAndSend ? { signAndSendTransaction: vi.fn(async () => SIG) } : {}),
  };
  return wallet;
}

beforeEach(() => { resetTxNotices(); sentry.capture.mockReset(); history.notify.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("errors", () => {
  it("classifies wallet rejections, expiry, not-sent and unknown", () => {
    expect(txFailureKind(Object.assign(new Error("User rejected the request."), { name: "WalletSignTransactionError" }))).toBe("rejected");
    expect(txFailureKind(new Error("Blockhash not found"))).toBe("expired");
    expect(txFailureKind(new Error("block height exceeded"))).toBe("expired");
    expect(txFailureKind(new TxNotSentError("prep failed"))).toBe("not-sent");
    expect(txFailureKind(Object.assign(new Error("x"), { sent: false }))).toBe("not-sent");
    expect(txFailureKind(new TxSendUnknownError(SIG, new Error("network")))).toBe("unknown");
    expect(txFailureKind(new Error("weird"))).toBe("unknown");
  });
  it("treats a bare timeout as not sent, but a relay timeout wrapped as unknown", () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    expect(txFailureKind(timeout)).toBe("not-sent");
    expect(plainTxError(timeout)).toBe("Preparing the transaction timed out. Nothing was sent; try again.");
    expect(txFailureKind(new TxSendUnknownError(SIG, timeout))).toBe("unknown");
  });
  it("uses plain words and never doubles punctuation", () => {
    expect(plainTxError(new Error("user rejected"))).toBe("You cancelled in your wallet. Nothing was sent.");
    expect(plainTxError(new Error("Blockhash not found"))).toBe(TX_EXPIRED_MESSAGE);
    expect(plainTxError(new TxNotSentError("Pool is paused"))).toBe("Pool is paused. Nothing was sent.");
    expect(plainTxError(new TxNotSentError("Pool is paused!"))).toBe("Pool is paused! Nothing was sent.");
    expect(plainTxError(new TxNotSentError("Already says nothing was sent."))).toBe("Already says nothing was sent.");
    expect(plainTxError(new TxSendUnknownError(SIG, null))).toContain("on Solscan");
  });
  it("only allows retry when nothing could have landed", () => {
    expect(["expired", "not-sent", "failed"].every((k) => canRetry(k as never))).toBe(true);
    expect(canRetry("unknown")).toBe(false); expect(canRetry("rejected")).toBe(false);
  });
});

describe("confirm", () => {
  const reply = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }) as Response);
  it("maps finality statuses and polls the signature only", async () => {
    expect(solscanTxUrl(SIG)).toBe(`https://solscan.io/tx/${SIG}`);
    expect(await readSignatureStatus({ signature: SIG, lastValidBlockHeight: 9, fetchImpl: reply({ status: "finalized" }) })).toBe("confirmed");
    expect(await readSignatureStatus({ signature: SIG, lastValidBlockHeight: 9, fetchImpl: reply({ status: "expired" }) })).toBe("expired");
    expect(await readSignatureStatus({ signature: SIG, lastValidBlockHeight: 9, fetchImpl: reply({}, false) })).toBe("pending");
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ ok: true, json: async () => ({ status: "pending" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "failed" }) });
    const sleep = vi.fn(async () => undefined);
    expect(await pollSignature({ signature: SIG, lastValidBlockHeight: 9, fetchImpl, sleep })).toBe("failed");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body)).toEqual({ signature: SIG, lastValidBlockHeight: 9, commitment: "confirmed" });
    expect(fetchImpl.mock.calls.every(([url]) => url === "/api/transaction-finality")).toBe(true);
  });
  it("stops when cancelled or after maxPolls", async () => {
    const fetchImpl = reply({ status: "pending" });
    expect(await pollSignature({ signature: SIG, lastValidBlockHeight: 9, fetchImpl, sleep: async () => undefined, maxPolls: 3 })).toBe("pending");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    let cancelled = false;
    expect(await pollSignature({ signature: SIG, lastValidBlockHeight: 9, fetchImpl, sleep: async () => { cancelled = true; }, isCancelled: () => cancelled })).toBe("pending");
  });
});

describe("attempts", () => {
  const attempt = (signature: string, createdAt = Date.now()): TxAttempt => ({ version: 1, flow: "add", wallet: WALLET, signature,
    lastValidBlockHeight: 10, createdAt, successTitle: "Liquidity added" });
  it("saves one record per signature and clears it when settled", () => {
    const storage = memoryStorage();
    saveTxAttempt(storage, attempt(SIG)); saveTxAttempt(storage, attempt(SIG));
    expect(loadTxAttempts(storage, WALLET)).toHaveLength(1);
    clearTxAttempt(storage, WALLET, SIG);
    expect(storage.map.has(txAttemptsKey(WALLET))).toBe(false);
  });
  it("ignores corrupt, foreign-wallet and day-old records", () => {
    const storage = memoryStorage();
    storage.setItem(txAttemptsKey(WALLET), "nope"); expect(loadTxAttempts(storage, WALLET)).toEqual([]);
    storage.setItem(txAttemptsKey(WALLET), JSON.stringify([{ ...attempt(SIG), wallet: "other" }, attempt(SIG, Date.now() - 25 * 3600_000)]));
    expect(loadTxAttempts(storage, WALLET)).toEqual([]);
  });
  it("never throws when storage is full", () => {
    const storage = { ...memoryStorage(), setItem: () => { throw new Error("QuotaExceeded"); } };
    expect(() => saveTxAttempt(storage, attempt(SIG))).not.toThrow();
  });
});

describe("wallet send", () => {
  it("lets the wallet sign and send when it can, and never relays", async () => {
    const wallet = signingWallet({ signAndSend: true }); const sendRaw = vi.fn();
    expect(await sendWithWallet(wallet, unsigned(), { sendRaw })).toEqual({ signature: SIG, via: "wallet" });
    expect(wallet.signTransaction).not.toHaveBeenCalled(); expect(sendRaw).not.toHaveBeenCalled();
  });
  it("refuses a wallet that returns no signature", async () => {
    const wallet = { ...signingWallet(), signAndSendTransaction: vi.fn(async () => "") };
    await expect(sendWithWallet(wallet, unsigned())).rejects.toBeInstanceOf(TxNotSentError);
  });
  it("refuses a transaction prepared for another wallet before the wallet is asked", async () => {
    const wallet = { ...signingWallet({ signAndSend: true }), address: testKeypair(99).publicKey.toBase58() };
    await expect(sendWithWallet(wallet, unsigned())).rejects.toThrow("different wallet");
    expect(wallet.signAndSendTransaction).not.toHaveBeenCalled();
  });
  it("falls back to sign + one relay send", async () => {
    const wallet = signingWallet(); const sendRaw = vi.fn(async (tx: VersionedTransaction) => sigOf(tx));
    const result = await sendWithWallet(wallet, unsigned(), { sendRaw });
    expect(result.via).toBe("relay"); expect(sendRaw).toHaveBeenCalledTimes(1); expect(result.signature).toBe(sigOf(wallet.signed[0]!));
  });
  it("falls back to sign + relay when the connector exposes signAndSend but the wallet lacks the feature", async () => {
    const wallet = { ...signingWallet(), signAndSendTransaction: vi.fn(async () => { throw new Error('The wallet does not support the "solana:signAndSendTransaction" feature'); }) };
    const sendRaw = vi.fn(async (tx: VersionedTransaction) => sigOf(tx));
    const result = await sendWithWallet(wallet, unsigned(), { sendRaw });
    expect(result.via).toBe("relay"); expect(wallet.signTransaction).toHaveBeenCalledTimes(1); expect(sendRaw).toHaveBeenCalledTimes(1);
  });
  it("does not fall back when the user rejects a signAndSend prompt", async () => {
    const wallet = { ...signingWallet(), signAndSendTransaction: vi.fn(async () => { throw new Error("User rejected the request."); }) };
    const sendRaw = vi.fn();
    await expect(sendWithWallet(wallet, unsigned(), { sendRaw })).rejects.toThrow("User rejected");
    expect(wallet.signTransaction).not.toHaveBeenCalled(); expect(sendRaw).not.toHaveBeenCalled();
  });
  it("uses sign-then-send when a cosigner must sign after the wallet, even if signAndSend exists", async () => {
    const wallet = signingWallet({ signAndSend: true });
    const cosign = vi.fn((tx: VersionedTransaction) => { tx.sign([cosigner]); return tx; });
    const sendRaw = vi.fn(async (tx: VersionedTransaction) => sigOf(tx));
    await sendWithWallet(wallet, unsigned(true), { cosign, sendRaw });
    expect(wallet.signAndSendTransaction).not.toHaveBeenCalled(); expect(cosign).toHaveBeenCalledTimes(1);
    expect(sendRaw.mock.calls[0]![0].signatures.every((s) => s.some((b) => b !== 0))).toBe(true);
  });
  it("refuses a missing co-signature without relaying", async () => {
    const sendRaw = vi.fn();
    await expect(sendWithWallet(signingWallet(), unsigned(true), { sendRaw })).rejects.toThrow("signature is missing");
    expect(sendRaw).not.toHaveBeenCalled();
  });
  it("drops a signature approved after the wallet or inputs changed", async () => {
    const sendRaw = vi.fn();
    await expect(sendWithWallet(signingWallet(), unsigned(), { sendRaw, stillWanted: () => false })).rejects.toBeInstanceOf(TxNotSentError);
    expect(sendRaw).not.toHaveBeenCalled();
  });
  it("maps a preflight refusal to not-sent and any other relay error to a tracked unknown", async () => {
    await expect(sendWithWallet(signingWallet(), unsigned(), { sendRaw: async () => { throw Object.assign(new Error("Simulation failed"), { sent: false }); } }))
      .rejects.toBeInstanceOf(TxNotSentError);
    const wallet = signingWallet();
    const error = await sendWithWallet(wallet, unsigned(), { sendRaw: async () => { throw new TypeError("Failed to fetch"); } }).catch((e) => e);
    expect(error).toBeInstanceOf(TxSendUnknownError); expect(error.signature).toBe(sigOf(wallet.signed[0]!));
    const mismatch = await sendWithWallet(signingWallet(), unsigned(), { sendRaw: async () => SIG }).catch((e) => e);
    expect(mismatch).toBeInstanceOf(TxSendUnknownError);
  });
  it("relays only the signed bytes with a timeout", async () => {
    const fetchMock = vi.fn(async () => Response.json({ signature: SIG })); vi.stubGlobal("fetch", fetchMock);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const tx = unsigned(); tx.sign([payer]);
    expect(await relaySignedTransaction(tx)).toBe(SIG);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("/api/tx-send"); expect(Object.keys(JSON.parse(String(init.body)))).toEqual(["signedTransaction"]);
    expect(timeout).toHaveBeenCalledWith(RELAY_TIMEOUT_MS); expect(init.signal).toBeInstanceOf(AbortSignal);
    fetchMock.mockResolvedValueOnce(Response.json({ error: "Simulation failed", sent: false }, { status: 400 }));
    await expect(relaySignedTransaction(tx)).rejects.toMatchObject({ message: "Simulation failed", sent: false });
  });
});

describe("notices", () => {
  it("tracks a sent signature, then shows success, clears the attempt and refreshes balances", () => {
    const storage = memoryStorage(); const refresh = vi.fn(); window.addEventListener(BALANCES_REFRESH_EVENT, refresh);
    saveTxAttempt(storage, { version: 1, flow: "open", wallet: WALLET, signature: SIG, lastValidBlockHeight: 5, createdAt: Date.now(), successTitle: "Position opened", positionMint: "mint" });
    trackTxSignature({ flow: "open", signature: SIG, lastValidBlockHeight: 5, wallet: WALLET, successTitle: "Position opened", positionMint: "mint" });
    expect(findTxNotice(noticeIdFor(SIG))).toMatchObject({ state: "loading", signature: SIG });
    settleTxNotice(noticeIdFor(SIG), "confirmed", storage);
    expect(findTxNotice(noticeIdFor(SIG))).toMatchObject({ state: "success", title: "Position opened", signature: SIG });
    expect(loadTxAttempts(storage, WALLET)).toEqual([]); expect(refresh).toHaveBeenCalledTimes(1);
    expect(history.notify).toHaveBeenCalledWith("mint", SIG);
    window.removeEventListener(BALANCES_REFRESH_EVENT, refresh);
  });
  it("reports expired and on-chain failures with a retry and Sentry", () => {
    const retry = vi.fn();
    trackTxSignature({ flow: "add", signature: SIG, lastValidBlockHeight: 5, wallet: WALLET, successTitle: "Liquidity added", retry });
    settleTxNotice(noticeIdFor(SIG), "expired");
    expect(findTxNotice(noticeIdFor(SIG))).toMatchObject({ state: "failure", kind: "expired", detail: TX_EXPIRED_MESSAGE, retry });
    expect(sentry.capture).toHaveBeenCalledWith("add", "expired", expect.any(String));
    trackTxSignature({ flow: "add", signature: SIG, lastValidBlockHeight: 5, wallet: WALLET, successTitle: "Liquidity added", retry });
    settleTxNotice(noticeIdFor(SIG), "failed");
    expect(findTxNotice(noticeIdFor(SIG))).toMatchObject({ state: "failure", kind: "failed", retry });
  });
  it("keeps an unconfirmed signature without offering a retry", () => {
    trackTxSignature({ flow: "add", signature: SIG, lastValidBlockHeight: 5, wallet: WALLET, successTitle: "x", retry: vi.fn() });
    settleTxNotice(noticeIdFor(SIG), "pending");
    expect(findTxNotice(noticeIdFor(SIG))).toMatchObject({ state: "failure", kind: "unknown", retry: undefined });
  });
  it("stays quiet on a wallet rejection", () => {
    expect(reportTxFailure({ flow: "add", error: new Error("User rejected the request") }).kind).toBe("rejected");
    expect(getTxNotices()).toEqual([]);
  });
  it("watches a notice through the finality endpoint", async () => {
    trackTxSignature({ flow: "withdraw", signature: SIG, lastValidBlockHeight: 5, wallet: WALLET, successTitle: "Withdrawn" });
    const fetchImpl = vi.fn(async () => Response.json({ status: "confirmed" }));
    expect(await watchTxNotice(noticeIdFor(SIG), { fetchImpl, sleep: async () => undefined })).toBe("confirmed");
    expect(findTxNotice(noticeIdFor(SIG))?.state).toBe("success");
  });
});

describe("runTx", () => {
  const adapter = (prepare: TxAdapter<unknown>["prepare"]): TxAdapter<unknown> => ({ flow: "add", successTitle: "Liquidity added", prepare });
  const prepared = () => ({ transaction: unsigned(), lastValidBlockHeight: 77, dispose: vi.fn() });
  it("prepare → wallet signAndSend → saved attempt + loading notice", async () => {
    const storage = memoryStorage(); const stages: string[] = []; const p = prepared(); const onPrepared = vi.fn();
    const result = await runTx(adapter(async () => p), {}, { wallet: signingWallet({ signAndSend: true }), storage,
      onStage: (s) => stages.push(s), onPrepared });
    expect(stages).toEqual(["preparing", "wallet", "confirming"]); expect(onPrepared).toHaveBeenCalledWith(p);
    expect(result.signature).toBe(SIG); expect(result.noticeId).toBe(noticeIdFor(SIG));
    expect(loadTxAttempts(storage, WALLET)).toMatchObject([{ signature: SIG, lastValidBlockHeight: 77, flow: "add" }]);
    expect(findTxNotice(noticeIdFor(SIG))?.state).toBe("loading"); expect(p.dispose).toHaveBeenCalledTimes(1);
  });
  it("turns a prepare failure into a plain not-sent error with a retry toast", async () => {
    const retry = vi.fn();
    const error = await runTx(adapter(async () => { throw new TxNotSentError("Pool is paused"); }), {}, { wallet: signingWallet(), retry }).catch((e) => e);
    expect(error).toBeInstanceOf(TxRunError);
    expect(error).toMatchObject({ kind: "not-sent", message: "Pool is paused. Nothing was sent.", retryable: true });
    expect(getTxNotices()[0]).toMatchObject({ state: "failure", retry });
  });
  it("stops before the wallet when the inputs changed during prepare", async () => {
    const wallet = signingWallet({ signAndSend: true });
    await expect(runTx(adapter(async () => prepared()), {}, { wallet, isCurrent: () => false })).rejects.toMatchObject({ kind: "not-sent" });
    expect(wallet.signAndSendTransaction).not.toHaveBeenCalled();
  });
  it("tracks a possibly-sent signature instead of failing or resending", async () => {
    const storage = memoryStorage(); const wallet = signingWallet(); const sendRaw = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const result = await runTx(adapter(async () => prepared()), {}, { wallet, storage, sendRaw });
    expect(result.signature).toBe(sigOf(wallet.signed[0]!)); expect(sendRaw).toHaveBeenCalledTimes(1);
    expect(loadTxAttempts(storage, WALLET)).toHaveLength(1);
  });
  it("is quiet and not retryable on a wallet rejection", async () => {
    const wallet = { ...signingWallet(), signAndSendTransaction: vi.fn(async () => { throw new Error("User rejected the request."); }) };
    await expect(runTx(adapter(async () => prepared()), {}, { wallet })).rejects.toMatchObject({ kind: "rejected", retryable: false });
    expect(getTxNotices()).toEqual([]);
  });
  it("sendAndTrack sends an already-prepared transaction once", async () => {
    const result = await sendAndTrack({ flow: "withdraw", successTitle: "Withdrawn", wallet: signingWallet({ signAndSend: true }), prepared: prepared() });
    expect(result.signature).toBe(SIG); expect(findTxNotice(result.noticeId)).toMatchObject({ flow: "withdraw", state: "loading" });
  });
});

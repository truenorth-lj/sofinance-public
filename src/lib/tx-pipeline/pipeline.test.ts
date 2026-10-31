// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { buildTransaction, testKeypair } from "@/lib/test-support/send-fixtures";

const sentry = vi.hoisted(() => ({ capture: vi.fn(), landed: vi.fn() }));
const history = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock("@/lib/sentry/client-tx", () => ({ captureTxClientFailure: sentry.capture, captureTxWalletErrorLanded: sentry.landed }));
vi.mock("@/lib/position-history-refresh", () => ({ notifyPositionHistoryChange: history.notify }));

import {
  BALANCES_REFRESH_EVENT, canRetry, clearTxAttempt, findTxNotice, getTxNotices, loadTxAttempts, noticeIdFor, plainTxError,
  pollSignature, readSignatureStatus, relaySignedTransaction, RELAY_TIMEOUT_MS, reportTxFailure, resetTxNotices, runTx,
  saveTxAttempt, sendAndTrack, sendWithWallet, settleTxNotice, solscanTxUrl, trackTxSignature, txAttemptsKey, txFailureKind,
  TxLandedUnknownError, TxNotLandedError, TxNotSentError, TxRunError, TxSendUnknownError, waitForLanded, walletErrorInfo, watchTxNotice,
  isWalletRejection, type FindLanded, type TxAdapter, type TxAttempt, type TxWallet,
} from "./index";
import { TX_EXPIRED_MESSAGE } from "@/lib/public-error";
import type { SendRaw } from "./wallet-send";

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

beforeEach(() => { resetTxNotices(); sentry.capture.mockReset(); sentry.landed.mockReset(); history.notify.mockReset(); });

/** What Phantom threw on the INTC add (2026-10, Safari): a code-400 JSON string AFTER it broadcast the transaction. */
const PHANTOM_400 = () => new Error('{"code":400,"message":"Request ce8e2677a1b2c3d4 rejected by user"}');
const USER_4001 = () => Object.assign(new Error("User rejected the request."), { code: 4001 });
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
  it("treats only 4001 or explicit rejection wording as a rejection, never Phantom's code-400 'rejected by user'", () => {
    expect(isWalletRejection(USER_4001())).toBe(true);
    expect(isWalletRejection({ code: 4001, message: "anything" })).toBe(true);
    expect(isWalletRejection(Object.assign(new Error("User rejected the request."), { name: "WalletSendTransactionError" }))).toBe(true);
    expect(isWalletRejection(PHANTOM_400())).toBe(false);
    expect(isWalletRejection({ code: 400, message: "Request x rejected by user" })).toBe(false);
    expect(isWalletRejection(new Error("Transaction declined by simulation"))).toBe(false);
    expect(walletErrorInfo(PHANTOM_400())).toEqual({ code: 400, message: "Request ce8e2677a1b2c3d4 rejected by user" });
    expect(walletErrorInfo(Object.assign(new Error("wrapped"), { error: { code: 4001, message: "User rejected" } }))).toMatchObject({ code: 4001 });
  });
  it("never shows raw wallet JSON", () => {
    for (const error of [PHANTOM_400(), new TxLandedUnknownError(PHANTOM_400()), new TxNotLandedError(false, PHANTOM_400())]) {
      const text = plainTxError(error);
      expect(text).not.toMatch(/[{}"]|code"?:|ce8e2677/);
    }
    expect(plainTxError(new TxNotLandedError(false, PHANTOM_400()))).toBe(
      "Your wallet reported a problem (“Request rejected by user”). We checked Solana and it did not go through. Nothing was sent, safe to retry.");
    expect(txFailureKind(new TxNotLandedError(true, USER_4001()))).toBe("not-sent");
    expect(txFailureKind(new TxLandedUnknownError(PHANTOM_400()))).toBe("unknown");
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
  it("checks the chain when a wallet returns no signature, and never claims nothing was sent without that check", async () => {
    const wallet = { ...signingWallet(), signAndSendTransaction: vi.fn(async () => "") };
    // No send permit: the lookup cannot run, so the outcome is unknown (not "safe to retry").
    await expect(sendWithWallet(wallet, unsigned())).rejects.toBeInstanceOf(TxLandedUnknownError);
    const findLanded = vi.fn<FindLanded>(async () => ({ status: "not-landed" }));
    const error = await sendWithWallet(wallet, unsigned(), { sendPermit: "permit", lastValidBlockHeight: 77, findLanded }).catch((e) => e);
    expect(error).toBeInstanceOf(TxNotLandedError); expect(error.message).toContain("safe to retry");
    expect(wallet.signTransaction).not.toHaveBeenCalled();
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
  it("relays the signed bytes with the prepared message and its permit, with a timeout", async () => {
    const fetchMock = vi.fn(async () => Response.json({ signature: SIG })); vi.stubGlobal("fetch", fetchMock);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const prepared = unsigned(); const tx = copy(prepared); tx.sign([payer]);
    expect(await relaySignedTransaction(tx, { prepared, sendPermit: "f".repeat(64) })).toBe(SIG);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(url).toBe("/api/tx-send"); expect(Object.keys(body)).toEqual(["signedTransaction", "unsignedTransaction", "sendPermit"]);
    expect(body.unsignedTransaction).toBe(Buffer.from(prepared.serialize()).toString("base64")); expect(body.sendPermit).toBe("f".repeat(64));
    expect(timeout).toHaveBeenCalledWith(RELAY_TIMEOUT_MS); expect(init.signal).toBeInstanceOf(AbortSignal);
    fetchMock.mockResolvedValueOnce(Response.json({ error: "Simulation failed", sent: false }, { status: 400 }));
    await expect(relaySignedTransaction(tx, { prepared })).rejects.toMatchObject({ message: "Simulation failed", sent: false });
  });
  it("passes the pristine prepared transaction and permit to the relay", async () => {
    const sendRaw = vi.fn<SendRaw>(async (tx) => sigOf(tx));
    const prepared = unsigned();
    await sendWithWallet(signingWallet(), prepared, { sendRaw, sendPermit: "permit" });
    const context = sendRaw.mock.calls[0]![1];
    expect(context.sendPermit).toBe("permit");
    expect(Buffer.from(context.prepared.serialize())).toEqual(Buffer.from(prepared.serialize()));
    expect(context.prepared.signatures.every((sig) => sig.every((b) => b === 0))).toBe(true);
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
  it("is quiet and not retryable when the user rejects signing (the sign-only path never broadcasts)", async () => {
    const wallet = { ...signingWallet(), signTransaction: vi.fn(async () => { throw USER_4001(); }) };
    const sendRaw = vi.fn();
    await expect(runTx(adapter(async () => prepared()), {}, { wallet, sendRaw })).rejects.toMatchObject({ kind: "rejected", retryable: false });
    expect(getTxNotices()).toEqual([]); expect(sendRaw).not.toHaveBeenCalled();
  });
  it("sendAndTrack sends an already-prepared transaction once", async () => {
    const result = await sendAndTrack({ flow: "withdraw", successTitle: "Withdrawn", wallet: signingWallet({ signAndSend: true }), prepared: prepared() });
    expect(result.signature).toBe(SIG); expect(findTxNotice(result.noticeId)).toMatchObject({ flow: "withdraw", state: "loading" });
  });
});

describe("landed check after a wallet error", () => {
  const adapter: TxAdapter<unknown> = { flow: "add", successTitle: "Liquidity added",
    prepare: async () => ({ transaction: unsigned(), lastValidBlockHeight: 77, sendPermit: "permit", dispose: vi.fn() }) };
  const throwingWallet = (error: () => unknown) => ({ ...signingWallet(), signAndSendTransaction: vi.fn(async () => { throw error(); }) });
  const LANDED = bs58.encode(new Uint8Array(64).fill(9));

  it("INTC case: wallet sends, then throws 400 'rejected by user', the tx landed → success with Solscan link + balance refresh", async () => {
    const refresh = vi.fn(); window.addEventListener(BALANCES_REFRESH_EVENT, refresh);
    const stages: string[] = []; const wallet = throwingWallet(PHANTOM_400);
    const findLanded = vi.fn<FindLanded>(async () => {
      // While the lookup runs the user sees a "Checking Solana…" notice, not the raw wallet error.
      expect(getTxNotices()).toMatchObject([{ state: "loading", title: "Checking Solana…" }]);
      return { status: "landed", signature: LANDED };
    });
    const result = await runTx(adapter, {}, { wallet, storage: memoryStorage(), findLanded, onStage: (s) => stages.push(s) });
    expect(stages).toEqual(["preparing", "wallet", "checking", "confirming"]);
    expect(result).toMatchObject({ signature: LANDED, landedAfterWalletError: true });
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    // The lookup gets the pristine prepared bytes, its send permit and the blockhash expiry.
    const check = findLanded.mock.calls[0]![0];
    expect(check).toMatchObject({ sendPermit: "permit", lastValidBlockHeight: 77 });
    expect(check.prepared.signatures.every((sig) => sig.every((b) => b === 0))).toBe(true);
    expect(sentry.landed).toHaveBeenCalledWith("add", expect.objectContaining({ walletErrorCode: 400 }));
    expect(sentry.capture).not.toHaveBeenCalled();
    const fetchImpl = vi.fn(async () => Response.json({ status: "confirmed" }));
    expect(await watchTxNotice(result.noticeId, { fetchImpl, sleep: async () => undefined })).toBe("confirmed");
    const notices = getTxNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ state: "success", title: "Liquidity added", signature: LANDED });
    expect(solscanTxUrl(notices[0]!.signature!)).toBe(`https://solscan.io/tx/${LANDED}`);
    expect(refresh).toHaveBeenCalled();
    window.removeEventListener(BALANCES_REFRESH_EVENT, refresh);
  });

  it("4001 and nothing landed after expiry → cancelled, nothing was sent, safe to retry (+ balance refresh)", async () => {
    const refresh = vi.fn(); window.addEventListener(BALANCES_REFRESH_EVENT, refresh);
    const retry = vi.fn();
    const findLanded = vi.fn<FindLanded>(async () => ({ status: "not-landed" }));
    const error = await runTx(adapter, {}, { wallet: throwingWallet(USER_4001), findLanded, retry }).catch((e) => e);
    expect(error).toBeInstanceOf(TxRunError);
    expect(error).toMatchObject({ kind: "not-sent", retryable: true,
      message: "You cancelled in your wallet. We checked Solana and it did not go through. Nothing was sent, safe to retry." });
    expect(getTxNotices()).toMatchObject([{ state: "failure", kind: "not-sent", retry }]);
    expect(refresh).toHaveBeenCalled();
    expect(sentry.capture).toHaveBeenCalledWith("add", "not-sent", expect.any(String),
      expect.objectContaining({ walletErrorCode: 4001, landedCheck: "not-landed" }));
    window.removeEventListener(BALANCES_REFRESH_EVENT, refresh);
  });

  it("an undecided lookup never says 'safe to retry' and offers no retry", async () => {
    const findLanded = vi.fn<FindLanded>(async () => ({ status: "unknown" }));
    const error = await runTx(adapter, {}, { wallet: throwingWallet(PHANTOM_400), findLanded, retry: vi.fn() }).catch((e) => e);
    expect(error).toMatchObject({ kind: "unknown", retryable: false });
    expect(error.message).not.toMatch(/safe to retry|nothing was sent/i); expect(error.message).not.toMatch(/[{}"]/);
    expect(getTxNotices()).toMatchObject([{ state: "failure", kind: "unknown", retry: undefined }]);
  });

  it("a landed-but-failed transaction is tracked by its signature, not reported as not sent", async () => {
    const findLanded = vi.fn<FindLanded>(async () => ({ status: "failed", signature: LANDED }));
    const result = await runTx(adapter, {}, { wallet: throwingWallet(PHANTOM_400), findLanded, storage: memoryStorage() });
    expect(result.signature).toBe(LANDED);
    const fetchImpl = vi.fn(async () => Response.json({ status: "failed" }));
    expect(await watchTxNotice(result.noticeId, { fetchImpl, sleep: async () => undefined })).toBe("failed");
    expect(findTxNotice(result.noticeId)).toMatchObject({ state: "failure", kind: "failed", signature: LANDED });
  });
});

describe("waitForLanded", () => {
  const check = (extra: Partial<Parameters<typeof waitForLanded>[0]> = {}) =>
    ({ prepared: unsigned(), sendPermit: "permit", lastValidBlockHeight: 77, preparedAt: 1_000, ...extra });
  it("polls through RPC errors and pending scans, carrying the checked signatures", async () => {
    const bodies: Record<string, unknown>[] = [];
    const replies = [new Response("x", { status: 502 }), Response.json({ status: "pending", checked: ["a", "b"] }),
      Response.json({ status: "landed", signature: SIG })];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init!.body))); return replies.shift()!; });
    const sleep = vi.fn(async () => undefined);
    expect(await waitForLanded(check(), { fetchImpl: fetchImpl as typeof fetch, sleep })).toEqual({ status: "landed", signature: SIG });
    expect(fetchImpl).toHaveBeenCalledTimes(3); expect(sleep).toHaveBeenCalledTimes(2);
    expect(bodies[0]).toMatchObject({ sendPermit: "permit", lastValidBlockHeight: 77, preparedAt: 1_000 });
    expect(bodies[0]!.checked).toBeUndefined(); expect(bodies[2]!.checked).toEqual(["a", "b"]);
    expect(fetchImpl.mock.calls[0]![0]).toBe("/api/tx-landed");
  });
  it("returns not-landed only when the server says so, unknown otherwise", async () => {
    const once = (response: Response) => vi.fn(async () => response) as unknown as typeof fetch;
    expect(await waitForLanded(check(), { fetchImpl: once(Response.json({ status: "not-landed" })) })).toEqual({ status: "not-landed" });
    expect(await waitForLanded(check(), { fetchImpl: once(Response.json({ error: "bad" }, { status: 400 })) })).toEqual({ status: "unknown" });
    expect(await waitForLanded(check({ sendPermit: undefined }), { fetchImpl: once(Response.json({ status: "not-landed" })) })).toEqual({ status: "unknown" });
    const pending = vi.fn(async () => Response.json({ status: "pending" })) as unknown as typeof fetch;
    expect(await waitForLanded(check(), { fetchImpl: pending, sleep: async () => undefined, maxPolls: 3 })).toEqual({ status: "unknown" });
    expect(pending).toHaveBeenCalledTimes(3);
  });
});

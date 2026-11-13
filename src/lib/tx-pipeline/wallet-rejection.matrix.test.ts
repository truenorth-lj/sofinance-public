// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { isUserRejectedError, shouldCaptureApiError } from "@/lib/sentry/capture";
import {
  COULDNT_SEND_TITLE, FLOW_LABEL, TxWalletCancelledError, isWalletRejection, plainTxError, txFailureKind,
} from "./errors";
import { getTxNotices, reportTxFailure, resetTxNotices } from "./notices";

/**
 * Phase D1 matrix (AUDIT): Phantom 4001 / Phantom 400 text / WalletConnect 5000 / MetaMask 4001 / generic
 * → UI title and Sentry capture decision. `isWalletRejection` is the single source; only an explicit
 * rejection may say "cancelled", and Sentry must use the same rule.
 */
const pending = () => new Promise<never>(() => undefined);
const err = (message: string, code?: number) => (code === undefined ? new Error(message) : Object.assign(new Error(message), { code }));

const CASES: { name: string; error: () => unknown; rejected: boolean }[] = [
  { name: "Phantom 4001 + 'User rejected the request.'", error: () => err("User rejected the request.", 4001), rejected: true },
  { name: "Phantom 4001 + unrelated text (code alone is enough)", error: () => err("anything", 4001), rejected: true },
  { name: "Phantom code 400 + 'Request x rejected by user' (wording after a broadcast is not a rejection)", error: () => err("Request x rejected by user", 400), rejected: false },
  { name: "WalletConnect 5000 + 'Request rejected by user'", error: () => err("Request rejected by user", 5000), rejected: true },
  { name: "MetaMask 4001 + 'User denied transaction signature.'", error: () => err("MetaMask Tx Signature: User denied transaction signature.", 4001), rejected: true },
  { name: "generic Error, no rejection wording", error: () => err("Transaction failed"), rejected: false },
  { name: "generic 'User rejected the request.' with no code", error: () => err("User rejected the request."), rejected: true },
  { name: "simulation decline wording must not count as a wallet rejection", error: () => err("Transaction declined by simulation"), rejected: false },
  { name: "wallet-adapter wrap of a 4001", error: () => Object.assign(new Error("wrapped"), { name: "WalletSendTransactionError", error: { code: 4001, message: "User rejected" } }), rejected: true },
];

beforeEach(() => resetTxNotices());

describe("wallet-rejection matrix: one classifier for UI copy and Sentry", () => {
  it.each(CASES)("$name", ({ error, rejected }) => {
    const value = error();
    expect(isWalletRejection(value)).toBe(rejected);
    expect(isUserRejectedError(value)).toBe(rejected);
    // Status 500 so the rejection rule, not the 4xx default, decides capture.
    expect(shouldCaptureApiError(value, 500)).toBe(!rejected);

    expect(txFailureKind(value) === "rejected").toBe(rejected);
    const message = plainTxError(value);
    if (rejected) expect(message).toMatch(/cancelled/i);
    else expect(message).not.toMatch(/cancelled/i);

    reportTxFailure({ flow: "open", error: new TxWalletCancelledError(value, pending()) });
    const [notice] = getTxNotices();
    expect(notice?.title).toBe(rejected ? `${FLOW_LABEL.open} cancelled` : COULDNT_SEND_TITLE);
    if (rejected) expect(notice?.detail).toMatch(/You cancelled in your wallet/);
    else expect(notice?.title).not.toMatch(/cancel/i);
  });
});

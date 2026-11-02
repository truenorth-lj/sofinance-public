// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  COULDNT_SEND_TITLE, isCouldntSend, sendFailureReason, TxLandedUnknownError, TxNotLandedError, TxRelayRefusedError, TxWalletCancelledError, walletWords,
} from "./errors";
import { getTxNotices, reportTxFailure, resetTxNotices } from "./notices";

/** A wallet / RPC error that embeds an endpoint with an API key: the address must never reach the screen. */
const RPC_ERROR = () => new Error("failed to send transaction: fetch failed at https://mainnet.example-rpc.com/v1/abcdef0123456789?api-key=SECRET123 (node mainnet.helius-rpc.com)");
const REJECTED = () => Object.assign(new Error("User rejected the request."), { code: 4001 });
const pending = () => new Promise<never>(() => undefined);

beforeEach(() => resetTxNotices());

describe("send failure copy (PM 2026-11-03): only a wallet rejection says cancelled", () => {
  it("an explicit wallet rejection keeps the cancelled toast", () => {
    reportTxFailure({ flow: "open", error: new TxWalletCancelledError(REJECTED(), pending()) });
    expect(getTxNotices()).toMatchObject([{ state: "failure", kind: "rejected", title: "Create position cancelled" }]);
    expect(getTxNotices()[0]!.detail).toMatch(/You cancelled in your wallet/);
  });

  it("any other wallet error is \"Couldn't send the transaction\" plus a plain reason (Raydium and registry flows share this pipeline)", () => {
    for (const flow of ["open", "add", "withdraw"] as const) {
      resetTxNotices();
      reportTxFailure({ flow, error: new TxWalletCancelledError(Object.assign(new Error("Unexpected error"), { name: "WalletSendTransactionError" }), pending()) });
      const [notice] = getTxNotices();
      expect(notice).toMatchObject({ state: "failure", title: COULDNT_SEND_TITLE });
      expect(notice!.title).not.toMatch(/cancel/i);
      expect(notice!.detail).toMatch(/^Couldn't send the transaction: your wallet said “Unexpected error”\./);
    }
  });

  it("never shows an RPC URL, host or key, in the title or the detail, for every failure shape", () => {
    const errors = [new TxWalletCancelledError(RPC_ERROR(), pending()), new TxNotLandedError(false, RPC_ERROR()), new TxLandedUnknownError(RPC_ERROR()), new TxRelayRefusedError(RPC_ERROR())];
    for (const error of errors) {
      resetTxNotices();
      reportTxFailure({ flow: "add", error });
      const [notice] = getTxNotices();
      expect(notice?.title).toBe(COULDNT_SEND_TITLE);
      const text = `${notice!.title} ${notice!.detail}`;
      expect(text).not.toMatch(/https?:|example-rpc|helius|api-key|SECRET123|abcdef0123456789|\.com/i);
      expect(text).toMatch(/^Couldn't send the transaction Couldn't send the transaction: /);
    }
    expect(walletWords(RPC_ERROR())).toBe("failed to send transaction: fetch failed at (node)");
  });

  it("reasons come from a fixed list of plain phrases; unknown words are quoted after cleaning", () => {
    expect(sendFailureReason(new Error("Transaction signature verification failure"))).toBe("Solana did not accept the transaction's signature");
    expect(sendFailureReason(new Error("Transaction simulation failed: custom program error 0x1771"))).toMatch(/pre-check says it would fail/);
    expect(sendFailureReason(new Error("Blockhash not found"))).toBe("it expired before it reached Solana");
    expect(sendFailureReason(new Error("insufficient funds for rent"))).toMatch(/not enough SOL/);
    expect(sendFailureReason(new Error(""))).toBe("your wallet did not say why");
    expect(sendFailureReason(new Error("broadcast unsent"), "network")).toBe("the network refused it (“broadcast unsent”)");
    expect(sendFailureReason(new Error('{"code":-32603,"message":"Internal error"}'))).toBe("your wallet said “Internal error”");
  });

  it("isCouldntSend: true for every send failure except a rejection", () => {
    expect(isCouldntSend(new TxWalletCancelledError(REJECTED(), pending()))).toBe(false);
    expect(isCouldntSend(new TxNotLandedError(true, REJECTED()))).toBe(false);
    expect(isCouldntSend(new TxNotLandedError(false, RPC_ERROR()))).toBe(true);
    expect(isCouldntSend(new TxLandedUnknownError(RPC_ERROR()))).toBe(true);
    expect(isCouldntSend(new TxRelayRefusedError("rpc_unavailable"))).toBe(true);
    expect(isCouldntSend(new Error("prepare failed"))).toBe(false);
  });
});

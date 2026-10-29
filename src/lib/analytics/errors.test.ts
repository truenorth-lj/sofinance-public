import { describe, expect, it } from "vitest";
import {
  classifyOpenError,
  classifyOpenErrorReason,
  openFailureProperties,
  openOutcomeFailureProperties,
  sanitizeOpenErrorMessage,
} from "./errors";

const wallet = "So11111111111111111111111111111111111111112";

describe("open error classes", () => {
  it("maps known failures to a coarse class and never echoes the raw text", () => {
    expect(classifyOpenError("User rejected the request")).toBe("user_rejected");
    expect(classifyOpenError(new Error("Transaction blockhash expired"))).toBe("expired");
    expect(classifyOpenError(`Transaction simulation failed for ${wallet}`)).toBe("simulation_failed");
    expect(classifyOpenError("Permit mismatch")).toBe("authorization");
    expect(classifyOpenError("Wallet removed or changed a required instruction (unmatched #0 program=alt)")).toBe("authorization");
    expect(classifyOpenError("socket hang up")).toBe("network");
    expect(classifyOpenError("Open-position transaction failed on-chain")).toBe("onchain_failed");
    expect(classifyOpenError(`secret key ${wallet} leaked`)).toBe("unknown");
    expect(classifyOpenError(`secret key ${wallet} leaked`)).not.toContain(wallet);
  });

  it("treats wallet error code 4001 as a user rejection, including wrapped adapter errors", () => {
    const inner = Object.assign(new Error("Something"), { code: 4001 });
    const wrapped = Object.assign(new Error(""), { name: "WalletSignTransactionError", error: inner });
    expect(classifyOpenError(wrapped)).toBe("user_rejected");
    expect(classifyOpenErrorReason(wrapped)).toBe("user_rejected");
  });
});

describe("open error reasons", () => {
  it.each([
    ["SOL deposits are temporarily unavailable — please use another token.", "sol_input_disabled"],
    ["Request blocked: this dApp could be malicious", "phantom_blocked"],
    ["User rejected the request.", "user_rejected"],
    ["Quote expired, refresh", "expired"],
    ["Insufficient SOL balance for rent", "insufficient_funds"],
    ["Price impact 7.2% exceeds 5%", "price_impact"],
    ["This amount is large for this pool's current depth. Try a smaller amount, a wider range, or refresh the quote.", "price_impact"],
    ["Transaction simulation failed: custom program error 0x1771", "simulation_failed"],
    ["Transaction payer mismatch", "authorization"],
    ["Open-position submission failed Transaction was not sent, safe to retry.", "broadcast_failed"],
    ["Failed to fetch", "network"],
    ["Preparing the transaction timed out", "network"],
    ["Open-position transaction failed on-chain", "onchain_failed"],
    ["Submission result is unconfirmed", "unconfirmed"],
    ["weird", "unknown"],
  ])("%s → %s", (message, reason) => {
    expect(classifyOpenErrorReason(new Error(message))).toBe(reason);
  });

  it("classifies timeouts by error name", () => {
    expect(classifyOpenErrorReason(new DOMException("signal timed out", "TimeoutError"))).toBe("network");
  });
});

describe("sanitized error message", () => {
  it("removes addresses, signatures, URLs, emails and credentials and caps the length", () => {
    const signature = "5".repeat(87);
    const message = sanitizeOpenErrorMessage(new Error(
      `Failed for ${wallet} sig ${signature} at https://rpc.example.com/?api-key=abc123 mail a.b@example.com token=sk_live_x`,
    ))!;
    expect(message).not.toContain(wallet);
    expect(message).not.toContain(signature);
    expect(message).not.toContain("rpc.example.com");
    expect(message).not.toContain("abc123");
    expect(message).not.toContain("a.b@example.com");
    expect(message).not.toContain("sk_live_x");
    expect(sanitizeOpenErrorMessage(new Error("x".repeat(500)))!.length).toBeLessThanOrEqual(120);
    expect(sanitizeOpenErrorMessage(new Error(""))).toBeUndefined();
    expect(sanitizeOpenErrorMessage({})).toBeUndefined();
  });

  it("builds failure properties", () => {
    expect(openFailureProperties(new Error("User rejected the request."))).toEqual({
      error_class: "user_rejected", error_reason: "user_rejected", error_message: "User rejected the request.",
    });
    expect(openOutcomeFailureProperties("expired")).toEqual({ error_class: "expired", error_reason: "expired" });
    expect(openOutcomeFailureProperties("failed")).toEqual({ error_class: "onchain_failed", error_reason: "onchain_failed" });
  });
});

describe("error_reason for previously-unknown open failures", () => {
  it.each([
    ["Prepared open-position transaction expired or incomplete", "stale_quote"],
    ["Prepared SOL swap expired or incomplete", "stale_quote"],
    ["Pool, wallet balance, or asset flags have changed since preparation", "stale_quote"],
    ["Wallet or input changed after step 1/2", "stale_quote"],
    ["Quote and current input mismatch, please re-enter amount", "stale_quote"],
    ["Pool price and swap ratio did not converge, please retry later", "stale_quote"],
    ["No routes found", "no_route"],
    ["Jupiter /build has no available routes (HTTP 400)", "no_route"],
    ["Complete swap + open-position transaction 1284 bytes, exceeds 1,232 byte limit", "tx_too_large"],
    ["Wallet additions exceed the 1,232 byte transaction limit", "tx_too_large"],
    ["Open-position history changed. Reload and verify the original signature before opening again.", "local_history"],
    ["Unable to clear unsent open-position record", "local_history"],
    ["Wallet did not return a valid signature", "wallet_error"],
    ["Wallet returned a different signature count than the prepared transaction", "wallet_error"],
    ["Open-position transaction is missing required signatures", "wallet_error"],
    ["Invalid step-1 swap signature", "invalid_input"],
    ["Input amount too small to allocate", "invalid_input"],
  ] as const)("%s -> %s", (message, reason) => {
    expect(classifyOpenErrorReason(new Error(message))).toBe(reason);
  });

  it("reads plain wallet rejection objects and wallet-adapter errors", () => {
    expect(classifyOpenErrorReason({ code: 4001, message: "User rejected the request." })).toBe("user_rejected");
    expect(classifyOpenErrorReason({ message: "User rejected the request." })).toBe("user_rejected");
    expect(classifyOpenErrorReason({ code: -32603, message: "Unexpected error" })).toBe("wallet_error");
    const adapter = Object.assign(new Error(""), { name: "WalletSignTransactionError" });
    expect(classifyOpenErrorReason(adapter)).toBe("wallet_error");
  });
});

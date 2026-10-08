import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { apiError } from "./api-response";
import {
  CompoundSendError, isPreflightOrUnsentFailure, mapKnownChainError, notSentRetryMessage,
  resolveCompoundBroadcastFailure, sanitizePublicError,
} from "./public-error";

afterEach(() => vi.restoreAllMocks());

describe("compound failure mapping", () => {
  it("maps Raydium 6017, token funds, and expired blockhash to short reasons", () => {
    expect(mapKnownChainError(`Compound simulation failed: {"InstructionError":[4,{"Custom":6017}]}; PriceSlippageCheck`))
      .toMatch(/6017/);
    expect(mapKnownChainError("custom program error: 0x1781")).toMatch(/6017/);
    expect(mapKnownChainError("Transfer: insufficient funds")).toMatch(/Insufficient tokens/);
    expect(mapKnownChainError("Blockhash not found")).toMatch(/blockhash expired/i);
    expect(mapKnownChainError("Compound blockhash expired")).toMatch(/blockhash expired/i);
  });

  it("returns a truncated sanitized reason instead of dropping long simulation logs", () => {
    const logs = Array.from({ length: 8 }, (_, index) =>
      `Program log: inner instruction ${index} consumed 200000 units with extra diagnostic text`).join(" | ");
    const raw = `Compound simulation failed: {"InstructionError":[5,{"Custom":6017}]}; ${logs}`;
    const message = sanitizePublicError(new Error(raw), "Compound transaction broadcast failed");
    expect(message).toMatch(/6017/);
    expect(message.length).toBeLessThanOrEqual(220);
    expect(message).not.toBe("Compound transaction broadcast failed");
  });

  it("redacts RPC URLs and API keys and never returns them to the client", () => {
    const raw = "RPC https://example.helius.xyz/?api-key=secret123 failed authorization=Bearer-abc token=leak";
    const message = sanitizePublicError(new Error(raw), "Compound transaction broadcast failed");
    expect(message).not.toMatch(/https?:\/\//);
    expect(message).not.toMatch(/secret123|Bearer-abc|token=leak|helius/i);
    expect(message).toMatch(/\[redacted\]/);
    expect(sanitizePublicError(new Error("Token program custom program error: 0x1"), "fallback"))
      .toMatch(/Insufficient tokens|Token program/);
  });

  it("treats simulation and known program errors as not-sent preflight failures", () => {
    expect(isPreflightOrUnsentFailure(new Error("Transaction simulation failed: custom program error: 0x1781"))).toBe(true);
    expect(isPreflightOrUnsentFailure(new Error("Compound simulation failed: no logs"))).toBe(true);
    expect(isPreflightOrUnsentFailure(new Error("Transaction was not confirmed in 30.00 seconds"))).toBe(false);
  });
});

describe("unsent broadcast UX", () => {
  it("abandons a persisted attempt only when the server says the tx was not sent", () => {
    expect(resolveCompoundBroadcastFailure({ persisted: true, sent: false, message: "Pool price moved past the add-liquidity cap (Raydium 6017)." }))
      .toEqual({
        abandon: true, keepPending: false,
        error: "Pool price moved past the add-liquidity cap (Raydium 6017). Transaction was not sent, safe to retry.",
      });
    expect(resolveCompoundBroadcastFailure({ persisted: true, message: "Compound transaction broadcast failed" }))
      .toEqual({ abandon: false, keepPending: true, error: "" });
    expect(resolveCompoundBroadcastFailure({ persisted: false, message: "User rejected the request." }))
      .toEqual({ abandon: false, keepPending: false, error: "User rejected the request." });
  });

  it("does not duplicate an existing not-sent retry sentence", () => {
    expect(notSentRetryMessage("Third reward yield appeared; transaction not sent")).toBe(
      "Third reward yield appeared; transaction not sent Safe to retry.");
    expect(notSentRetryMessage("Compound blockhash expired. Transaction was not sent, safe to retry."))
      .toBe("Compound blockhash expired. Transaction was not sent, safe to retry.");
  });
});

describe("apiError logging and sent flag", () => {
  it("logs the full error and returns sent:false with a mapped reason", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cause = new Error(`Compound simulation failed: {"InstructionError":[3,{"Custom":6017}]}; Program log: PriceSlippageCheck`);
    const response = apiError(new CompoundSendError(cause, false), "Compound transaction broadcast failed");
    const body = await response.json() as { error: string; sent?: boolean };
    expect(body.sent).toBe(false);
    expect(body.error).toMatch(/6017/);
    expect(body.error).not.toBe("Compound transaction broadcast failed");
    expect(logged).toHaveBeenCalled();
  });
});

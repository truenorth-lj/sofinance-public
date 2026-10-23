import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { apiError } from "./api-response";
import { CROSS_LIQUIDITY_BAND_MESSAGE } from "@sofinance/engine/liquidity-band";
import { JupiterHttpError, JUPITER_UNAVAILABLE_CODE, JUPITER_UNAVAILABLE_MESSAGE } from "@sofinance/engine/jupiter/errors";
import {
  CompoundSendError, CROSS_TICK_USER_MESSAGE, isPreflightOrUnsentFailure, mapKnownChainError, notSentRetryMessage,
  publicErrorCode, resolveCompoundBroadcastFailure, sanitizePublicError,
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

  it("maps RPC 429 provider JSON to a short retry message and drops the raw body", () => {
    const message = sanitizePublicError(
      new Error("429 Too Many Requests: Too many requests for a specific RPC call"),
      "Exit source unavailable",
    );
    expect(message).toBe("Solana RPC is temporarily unavailable. Please retry in a moment.");
    expect(message).not.toMatch(/Too many requests for a specific RPC|429/);
    expect(publicErrorCode(new Error("429 Too Many Requests: Too many requests for a specific RPC call"))).toBe("rpc_unavailable");
  });

  it("maps Jupiter no-route to a coded user-facing add-liquidity message", () => {
    const noRoute = new JupiterHttpError(400, "/swap/v1/quote", null, "No routes found");
    expect(sanitizePublicError(noRoute, "Quote failed")).toMatch(/transaction size limit/);
    expect(sanitizePublicError(noRoute, "Quote failed")).not.toMatch(/HTTP 400/);
    expect(publicErrorCode(noRoute)).toBe("jupiter_no_route");
  });

  it("maps Jupiter dust-threshold 400 to a coded amount-too-small message", () => {
    const dust = new JupiterHttpError(400, "/swap/v1/quote", null,
      "Cannot compute other amount threshold, with amount 1 and slippageBps 50");
    expect(sanitizePublicError(dust, "Quote failed")).toBe(
      "Amount too small to swap into this position — try a larger amount");
    expect(sanitizePublicError(dust, "Quote failed")).not.toMatch(/HTTP 400/);
    expect(publicErrorCode(dust)).toBe("amount_too_small");
  });

  it("surfaces Jupiter's 400 body instead of bare HTTP 400", () => {
    const rejected = new JupiterHttpError(400, "/swap/v1/quote", null, "Token not tradable");
    expect(sanitizePublicError(rejected, "Quote failed")).toBe("Token not tradable");
    expect(sanitizePublicError(rejected, "Quote failed")).not.toMatch(/HTTP 400/);
    expect(publicErrorCode(rejected)).toBe("jupiter_client_error");
    expect(sanitizePublicError(new JupiterHttpError(400, "/swap/v1/quote"), "Quote failed"))
      .toBe("Jupiter rejected this quote.");
  });

  it("keeps Jupiter 429/5xx distinct from the Solana RPC message", () => {
    const jupiter = new JupiterHttpError(429, "/swap/v1/quote");
    expect(sanitizePublicError(jupiter, "Exit source unavailable")).toBe(JUPITER_UNAVAILABLE_MESSAGE);
    expect(publicErrorCode(jupiter)).toBe(JUPITER_UNAVAILABLE_CODE);
    expect(sanitizePublicError(new Error("Jupiter HTTP 503"), "fallback")).toBe(JUPITER_UNAVAILABLE_MESSAGE);
    expect(sanitizePublicError(jupiter, "fallback")).not.toMatch(/Solana RPC/);
  });

  it("maps cross-tick and cross-position-boundary engine errors to a short user action", () => {
    const logged = vi.spyOn(console, "info").mockImplementation(() => undefined);
    expect(sanitizePublicError(new Error(CROSS_LIQUIDITY_BAND_MESSAGE), "Open-position quote failed"))
      .toBe(CROSS_TICK_USER_MESSAGE);
    expect(sanitizePublicError(new Error("Swap may cause target pool price to cross position boundary, please re-quote"), "failed"))
      .toBe(CROSS_TICK_USER_MESSAGE);
    expect(sanitizePublicError(new Error("Swap may cause target pool price to cross the selected range, please re-quote"), "failed"))
      .toBe(CROSS_TICK_USER_MESSAGE);
    expect(sanitizePublicError(new Error(CROSS_LIQUIDITY_BAND_MESSAGE), "failed")).not.toMatch(/tick-spacing|cross-tick depth/i);
    expect(logged).toHaveBeenCalled();
    expect(String(logged.mock.calls[0])).toMatch(/tick-spacing boundary|cross-tick depth/);
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

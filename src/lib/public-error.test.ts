import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { apiError } from "./api-response";
import { CROSS_LIQUIDITY_BAND_MESSAGE } from "@sofinance/engine/liquidity-band";
import { SelectedNoRouteError } from "./selected-no-route";
import { JupiterHttpError, JUPITER_UNAVAILABLE_CODE, JUPITER_UNAVAILABLE_MESSAGE } from "@sofinance/engine/jupiter/errors";
import {
  CompoundSendError, CROSS_TICK_USER_MESSAGE, isPreflightOrUnsentFailure, mapKnownChainError, notSentRetryMessage,
  publicErrorCode, resolveCompoundBroadcastFailure, sanitizePublicError,
  errorText,
} from "./public-error";

afterEach(() => vi.restoreAllMocks());

describe("serialized transaction diagnostics", () => {
  it.each(["api-key", "authorization", "access_token", "refresh_token", "client_secret", "JUPITER_API_KEY", "X-Auth-Token"])(
    "scrubs %s after errorText serializes transactionError", (key) => {
      const secret = "R2_KEY_7";
      const transactionError = { message: JSON.stringify({ [key]: secret }), code: "E_UPSTREAM" };
      const error = Object.assign(new Error("provider failed"), { transactionError });
      // This is the reviewer's real path, not a pre-scrubbed input to a helper.
      expect(errorText(error)).toBe(`provider failed ${JSON.stringify(transactionError)}`);
      const result = sanitizePublicError(error, "Request failed");
      expect(result).not.toContain(secret);
      expect(result).toContain("provider failed");
      expect(result).toContain("E_UPSTREAM");
      expect(transactionError.message).toContain(secret);
    },
  );

  it("preserves serialized program errors and ordinary diagnostic keys", () => {
    const error = Object.assign(new Error("provider failed"), {
      transactionError: { InstructionError: [2, { Custom: 6021 }], design: "retry", mytoken: "missing", tokenizer: "ready" },
    });
    expect(sanitizePublicError(error, "fallback")).toContain("Raydium rejected the liquidity change.");
    expect(sanitizePublicError(error, "fallback")).toContain('"Custom":6021');
    expect(sanitizePublicError(error, "fallback")).toContain('"mytoken":"missing"');
  });
});

describe("shared credential text policy", () => {
  const secret = "REVIEW_SYNTHETIC_ONLY_20261027";
  it.each([
    `Authorization: Bearer ${secret}`,
    `Authorization: Basic ${secret}+TAIL==`,
    JSON.stringify({ "api-key": secret }),
    JSON.stringify({ authorization: `Bearer ${secret}` }),
    encodeURIComponent(`https://rpc.invalid/?api-key=${secret}`),
  ])("scrubs public details and upstream bodies: %s", (credential) => {
    for (const error of [
      new Error(`provider failed ${credential}`),
      new JupiterHttpError(400, "/swap/v1/quote", null, `provider failed ${credential}`),
      Object.assign(new Error("provider failed"), { logs: [credential], transactionError: { "api-key": secret } }),
      new SelectedNoRouteError(`provider failed ${credential}`, "SOL", "input", "output"),
    ]) {
      const result = sanitizePublicError(error, "fallback");
      expect(result).not.toContain(secret);
      expect(result).not.toContain("TAIL");
      expect(result).not.toContain("rpc.invalid");
      expect(result).toContain("provider failed");
      expect(result.length).toBeLessThanOrEqual(220);
    }
    expect(sanitizePublicError(new Error(""), credential)).not.toContain(secret);
  });

  it("keeps ordinary diagnostics and scrubs the cross-tick console detail", () => {
    const normal = "Token program failed: code=E_UPSTREAM; 2+2=4; progress 50%";
    expect(sanitizePublicError(new Error(normal), "fallback")).toBe(normal);
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(sanitizePublicError(new Error(`cross-tick depth; Authorization: Bearer ${secret}`), "fallback"))
      .toBe(CROSS_TICK_USER_MESSAGE);
    expect(String(logged.mock.calls)).not.toContain(secret);
  });
});

describe("compound failure mapping", () => {
  it("maps Raydium 6017, token funds, and expired blockhash to short reasons", () => {
    expect(mapKnownChainError(`Compound simulation failed: {"InstructionError":[4,{"Custom":6017}]}; PriceSlippageCheck`))
      .toMatch(/6017/);
    expect(mapKnownChainError("custom program error: 0x1781")).toMatch(/6017/);
    expect(mapKnownChainError("Transfer: insufficient funds")).toMatch(/Insufficient tokens/);
    expect(mapKnownChainError("Blockhash not found")).toMatch(/expired before Solana included it/i);
    expect(mapKnownChainError("Compound blockhash expired")).toMatch(/expired before Solana included it/i);
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

describe("compound insufficient SOL", () => {
  it("passes the add-SOL copy through unchanged and tags it with a stable code", async () => {
    const { CompoundInsufficientSolError } = await import("@sofinance/engine/compound-simulation");
    const error = new CompoundInsufficientSolError(5_016_195n);
    expect(publicErrorCode(error)).toBe("insufficient_sol");
    const response = apiError(error, "Compound transaction preparation failed");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "insufficient_sol",
      error: "Not enough SOL: add about 0.0051 SOL more to cover network fees and temporary account rent (0.01 SOL must stay in your wallet), then try again." });
    expect(publicErrorCode(new Error("Compound SOL expenditure or remaining balance exceeds limit"))).toBeUndefined();
  });
});

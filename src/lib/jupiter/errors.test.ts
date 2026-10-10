import { describe, expect, it } from "vitest";
import {
  asJupiterUserError,
  classifyJupiterError,
  isJupiterUpstreamError,
  JupiterHttpError,
  JupiterUnavailableError,
  JUPITER_UNAVAILABLE_CODE,
  JUPITER_UNAVAILABLE_MESSAGE,
  looksLikeJupiterUpstream,
} from "./errors";

describe("jupiter error mapping", () => {
  it("treats Jupiter 429/5xx as upstream, not a generic 400", () => {
    expect(isJupiterUpstreamError(new JupiterHttpError(429, "/swap/v1/quote"))).toBe(true);
    expect(isJupiterUpstreamError(new JupiterHttpError(503, "/swap/v1/quote"))).toBe(true);
    expect(isJupiterUpstreamError(new JupiterHttpError(400, "/swap/v1/quote"))).toBe(false);
    expect(isJupiterUpstreamError(new Error("Jupiter HTTP 429"))).toBe(true);
    expect(isJupiterUpstreamError(new Error("429 Too Many Requests: Too many requests for a specific RPC call"))).toBe(false);
    expect(looksLikeJupiterUpstream("Jupiter HTTP 503")).toBe(true);
    expect(looksLikeJupiterUpstream("RPC 429 Too Many Requests")).toBe(false);
  });

  it("classifies retryable kinds", () => {
    expect(classifyJupiterError(new JupiterHttpError(429, "/price/v3"))).toBe("rate-limit");
    expect(classifyJupiterError(new JupiterHttpError(502, "/price/v3"))).toBe("http-5xx");
    expect(classifyJupiterError(new JupiterHttpError(400, "/price/v3"))).toBe("http-4xx");
    const timeout = new Error("aborted due to timeout");
    timeout.name = "TimeoutError";
    expect(classifyJupiterError(timeout)).toBe("timeout");
  });

  it("rewrites upstream failures to the Jupiter user message", () => {
    const mapped = asJupiterUserError(new JupiterHttpError(429, "/swap/v1/quote"));
    expect(mapped).toBeInstanceOf(JupiterUnavailableError);
    expect(mapped.message).toBe(JUPITER_UNAVAILABLE_MESSAGE);
    expect((mapped as JupiterUnavailableError).code).toBe(JUPITER_UNAVAILABLE_CODE);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { JupiterHttpError } from "./errors";
import { defaultJupiterLogger, formatJupiterLog, jupiterLogEnabled, logExitPreviewFailure, setJupiterLogger } from "./logger";

afterEach(() => {
  delete process.env.SOFINANCE_RPC_LOG;
  delete process.env.SOFINANCE_JUPITER_LOG;
  setJupiterLogger(null);
  vi.restoreAllMocks();
});

describe("jupiterLogEnabled", () => {
  it("is on for SOFINANCE_JUPITER_LOG or SOFINANCE_RPC_LOG", () => {
    expect(jupiterLogEnabled({})).toBe(false);
    expect(jupiterLogEnabled({ SOFINANCE_JUPITER_LOG: "1" })).toBe(true);
    expect(jupiterLogEnabled({ SOFINANCE_RPC_LOG: "true" })).toBe(true);
    expect(jupiterLogEnabled({ SOFINANCE_JUPITER_LOG: "0", SOFINANCE_RPC_LOG: "0" })).toBe(false);
  });
});

describe("formatJupiterLog", () => {
  it("emits key-free structured fields", () => {
    const line = formatJupiterLog({
      path: "/swap/v1/quote",
      method: "GET",
      outcome: "retry",
      attempt: 2,
      retries: 1,
      cacheHit: false,
      errorKind: "rate-limit",
      status: 429,
    });
    expect(JSON.parse(line)).toEqual({
      jupiter: true,
      path: "/swap/v1/quote",
      method: "GET",
      outcome: "retry",
      status: 429,
      retries: 1,
      cacheHit: false,
      attempt: 2,
    });
    expect(line).not.toMatch(/api_key|https?:\/\//);
  });
});

describe("defaultJupiterLogger", () => {
  it("stays quiet unless a log flag is set", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    defaultJupiterLogger({ path: "/price/v3", method: "GET", outcome: "ok" });
    expect(info).not.toHaveBeenCalled();
    process.env.SOFINANCE_RPC_LOG = "1";
    defaultJupiterLogger({ path: "/price/v3", method: "GET", outcome: "cache-hit", cacheHit: true });
    expect(info).toHaveBeenCalledOnce();
    expect(String(info.mock.calls[0]![0])).toContain("\"cacheHit\":true");
  });
});

describe("logExitPreviewFailure", () => {
  it("always logs a key-free class and message", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    logExitPreviewFailure(new JupiterHttpError(429, "/swap/v1/quote"));
    const payload = JSON.parse(String(info.mock.calls[0]![0])) as Record<string, unknown>;
    expect(payload).toMatchObject({
      exitPreview: true,
      errorName: "JupiterHttpError",
      errorMessage: "Jupiter HTTP 429",
      httpStatus: 429,
      path: "/swap/v1/quote",
      jupiter: true,
    });
    logExitPreviewFailure(new Error("RPC https://example.invalid/?api-key=secret failed"));
    const redacted = String(info.mock.calls[1]![0]);
    expect(redacted).toContain("[redacted]");
    expect(redacted).not.toMatch(/secret|example\.invalid/);
  });
});

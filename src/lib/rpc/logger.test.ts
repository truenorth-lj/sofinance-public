import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRpcLogger, formatRpcLog, rpcLogEnabled, setRpcLogger } from "./logger";

afterEach(() => {
  delete process.env.SOFINANCE_RPC_LOG;
  setRpcLogger(null);
  vi.restoreAllMocks();
});

describe("rpcLogEnabled", () => {
  it("is off by default and on for 1/true/on", () => {
    expect(rpcLogEnabled({})).toBe(false);
    expect(rpcLogEnabled({ SOFINANCE_RPC_LOG: "1" })).toBe(true);
    expect(rpcLogEnabled({ SOFINANCE_RPC_LOG: "true" })).toBe(true);
    expect(rpcLogEnabled({ SOFINANCE_RPC_LOG: "on" })).toBe(true);
    expect(rpcLogEnabled({ SOFINANCE_RPC_LOG: "0" })).toBe(false);
  });
});

describe("formatRpcLog", () => {
  it("emits key-free structured fields", () => {
    const line = formatRpcLog({
      method: "simulateTransaction",
      provider: "solami",
      outcome: "retry",
      attempt: 2,
      retries: 1,
      cacheHit: false,
      errorKind: "rate-limit",
    });
    expect(JSON.parse(line)).toEqual({
      rpc: true,
      method: "simulateTransaction",
      provider: "solami",
      outcome: "retry",
      status: "rate-limit",
      retries: 1,
      cacheHit: false,
      attempt: 2,
    });
    expect(line).not.toMatch(/api_key|https?:\/\//);
  });
});

describe("defaultRpcLogger", () => {
  it("stays quiet unless SOFINANCE_RPC_LOG is set", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    defaultRpcLogger({ method: "getAccountInfo", provider: "default", outcome: "ok" });
    expect(info).not.toHaveBeenCalled();
    process.env.SOFINANCE_RPC_LOG = "1";
    defaultRpcLogger({ method: "getAccountInfo", provider: "solami", outcome: "cache-hit", cacheHit: true });
    expect(info).toHaveBeenCalledOnce();
    expect(String(info.mock.calls[0]![0])).toContain("\"cacheHit\":true");
    expect(String(info.mock.calls[0]![0])).not.toMatch(/api_key/);
  });
});

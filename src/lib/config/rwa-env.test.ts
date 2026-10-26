import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  getRwaConfig,
  DEFAULT_RWA_SCHEDULER_INTERVAL_MS,
  rwaSchedulerIntervalMs,
} from "./rwa-env";

describe("rwaSchedulerIntervalMs", () => {
  it("defaults to 15 minutes so the 30-minute APR expiry is never reached", () => {
    expect(rwaSchedulerIntervalMs(undefined)).toBe(900_000);
    expect(rwaSchedulerIntervalMs("")).toBe(DEFAULT_RWA_SCHEDULER_INTERVAL_MS);
  });

  it("accepts an integer override inside 30 s – 1 h", () => {
    expect(rwaSchedulerIntervalMs("30000")).toBe(30_000);
    expect(rwaSchedulerIntervalMs("3600000")).toBe(3_600_000);
  });

  it.each(["29999", "3600001", "1.5", "abc", "-1"])("rejects %s", (raw) => {
    expect(() => rwaSchedulerIntervalMs(raw)).toThrow("Invalid RWA configuration");
  });
});


afterEach(() => vi.unstubAllEnvs());
describe("store rollout configuration", () => {
  it("defaults to gateway and keeps native GET disabled", () => {
    vi.stubEnv("SOFINANCE_RWA_STORE_MODE", undefined);
    vi.stubEnv("SOFINANCE_RWA_NATIVE_CRON_ENABLED", undefined);
    expect(getRwaConfig()).toMatchObject({ storeMode: "gateway", nativeCronEnabled: false });
  });
  it("selects neon explicitly even while gateway env remains", () => {
    vi.stubEnv("SOFINANCE_RWA_STORE_MODE", "neon");
    vi.stubEnv("SOFINANCE_RWA_GATEWAY_URL", "https://old.invalid");
    vi.stubEnv("SOFINANCE_RWA_NATIVE_CRON_ENABLED", "true");
    expect(getRwaConfig()).toMatchObject({ storeMode: "neon", nativeCronEnabled: true });
  });
  it.each(["auto", "Neon", "direct", " "])("fails closed for mode %s", (mode) => {
    vi.stubEnv("SOFINANCE_RWA_STORE_MODE", mode);
    expect(() => getRwaConfig()).toThrow("Invalid RWA store mode");
  });
});

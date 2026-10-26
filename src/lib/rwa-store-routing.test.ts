import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ rwa: vi.fn(), position: vi.fn(), databases: [] as unknown[] }));
vi.mock("./rwa-postgres-store", () => ({ PostgresRwaStore: class {
  constructor(db: unknown) { state.databases.push(db); }
  request = state.rwa;
} }));
vi.mock("./position-history-postgres-store", () => ({ PostgresPositionHistoryStore: class {
  constructor(db: unknown) { state.databases.push(db); }
  request = state.position;
} }));
import { getRwaStore } from "./rwa-store";
import { getPositionHistoryStore } from "./position-history-store";
import { RwaStoreError } from "./rwa-store-types";
import { PositionHistoryStoreError } from "./position-history-store-types";
const context = Object.fromEntries(["positionMint", "positionAccount", "poolId", "mintA", "mintB", "vaultA", "vaultB"]
  .map(key => [key, "1".repeat(32)])) as { positionMint: string; positionAccount: string; poolId: string;
    mintA: string; mintB: string; vaultA: string; vaultB: string };
const positionRequest = { op: "claim" as const, context, parserVersion: 1 };
beforeEach(() => {
  vi.stubEnv("SOFINANCE_RWA_STORE_MODE", "neon");
  vi.stubEnv("SOFINANCE_RWA_DB_EXPECTED_ROLE", "sofinance_owner");
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("DATABASE_URL", "postgres://sofinance_owner:dummy@ep-public.ap-southeast-1.aws.neon.tech/sofinance");
  vi.stubEnv("SOFINANCE_RWA_GATEWAY_URL", "https://old.invalid");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected gateway fallback"); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("explicit store routing", () => {
  it("shares one Neon pool between both store constructors on Vercel and ignores stale gateway", async () => {
    state.rwa.mockResolvedValue({ saved: true });
    state.position.mockResolvedValue({ saved: true });
    await expect(getRwaStore().request({ op: "activePools" })).resolves.toEqual({ saved: true });
    await expect(getPositionHistoryStore().request(positionRequest)).resolves.toEqual({ saved: true });
    expect(state.databases).toHaveLength(2);
    expect(state.databases[0]).toBe(state.databases[1]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("fails closed on missing Neon URL instead of silently selecting the old gateway", () => {
    vi.stubEnv("DATABASE_URL", undefined);
    expect(() => getRwaStore()).toThrow("RWA_STORE_UNAVAILABLE");
    expect(() => getPositionHistoryStore()).toThrow("POSITION_STORE_UNAVAILABLE");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("sanitizes database errors while preserving stable business fencing errors", async () => {
    state.rwa.mockRejectedValueOnce(new Error("postgres private detail"));
    state.position.mockRejectedValueOnce(new Error("postgres private detail"));
    await expect(getRwaStore().request({ op: "activePools" })).rejects.toThrow("RWA_STORE_UNAVAILABLE");
    await expect(getPositionHistoryStore().request(positionRequest)).rejects.toThrow("POSITION_STORE_UNAVAILABLE");
    state.rwa.mockRejectedValueOnce(new RwaStoreError("LEASE_LOST"));
    state.position.mockRejectedValueOnce(new PositionHistoryStoreError("LEASE_LOST"));
    await expect(getRwaStore().request({ op: "activePools" })).rejects.toThrow("LEASE_LOST");
    await expect(getPositionHistoryStore().request(positionRequest)).rejects.toThrow("LEASE_LOST");
    expect(fetch).not.toHaveBeenCalled();
  });
});

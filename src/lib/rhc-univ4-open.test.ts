import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import type { PublicClient } from "viem";
import { RhcOpenInputError, RhcOpenRequestSchema, runRhcUniv4Open } from "./rhc-univ4-open";

const POOL = "0x4f54c74021e4139bbc4c7bc924346c921975136ea120cf118a93c43b50bdbd3c";
const USER = "0xab9069703d7df7c4a472bc634312f087f0b9b320";
const base = { action: "prepare" as const, poolId: POOL, user: USER, depositToken: "0x4a0E65A3ecceC6dBE60aE065F2e7bB85faE35eEa", amount: "1", tickLower: -11, tickUpper: 9 };
const noClient = {} as PublicClient;

describe("runRhcUniv4Open input checks", () => {
  it("rejects pools outside the allowlist and tokens outside the pool before any RPC", async () => {
    await expect(runRhcUniv4Open(RhcOpenRequestSchema.parse({ ...base, poolId: `0x${"11".repeat(32)}` }), { client: noClient })).rejects.toThrow(RhcOpenInputError);
    await expect(runRhcUniv4Open(RhcOpenRequestSchema.parse({ ...base, depositToken: USER }), { client: noClient })).rejects.toThrow("Deposit token is not in this pool");
    await expect(runRhcUniv4Open(RhcOpenRequestSchema.parse({ ...base, amount: "0" }), { client: noClient })).rejects.toThrow("Amount must be positive");
  });
  it("rejects a range narrower than ±10 ticks with the PM error (no RPC needed)", async () => {
    const result = await runRhcUniv4Open(RhcOpenRequestSchema.parse({ ...base, tickLower: -5, tickUpper: 5 }), { client: noClient }).catch(e => e);
    expect(JSON.stringify(result)).toMatch(/minimum is ±10 ticks/);
  });
});

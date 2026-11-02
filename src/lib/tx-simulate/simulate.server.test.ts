import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { buildTransaction, testKeypair } from "@/lib/test-support/send-fixtures";
import { simulateBeforeWallet } from "./simulate.server";
import { SIM_EXPIRED_CAUSE, SIM_SLIPPAGE_CAUSE } from "./cause";

const tx = () => buildTransaction({ payer: testKeypair(31), signWith: [] });
const connection = (impl: () => Promise<unknown>) => ({ simulateTransaction: vi.fn(impl) }) as never as Parameters<typeof simulateBeforeWallet>[1] & { simulateTransaction: ReturnType<typeof vi.fn> };

describe("simulateBeforeWallet", () => {
  it("simulates the exact bytes without signature checks and keeps the real blockhash", async () => {
    const conn = connection(async () => ({ value: { err: null, logs: [], unitsConsumed: 1234 } }));
    expect(await simulateBeforeWallet(tx(), conn)).toEqual({ ok: true, unitsConsumed: 1234 });
    expect(conn.simulateTransaction.mock.calls[0]![1]).toMatchObject({ sigVerify: false, replaceRecentBlockhash: false });
  });
  it("returns the plain cause of a failed simulation", async () => {
    const conn = connection(async () => ({ value: { err: { InstructionError: [1, { Custom: 6001 }] }, logs: ["Program log: Error: SlippageToleranceExceeded"] } }));
    expect(await simulateBeforeWallet(tx(), conn)).toEqual({ ok: false, cause: SIM_SLIPPAGE_CAUSE });
  });
  it("treats an RPC error as unavailable, except an expired blockhash", async () => {
    expect(await simulateBeforeWallet(tx(), connection(async () => { throw new Error("429 Too Many Requests"); }))).toEqual({ ok: null, unavailable: true });
    expect(await simulateBeforeWallet(tx(), connection(async () => { throw new Error("Blockhash not found"); }))).toEqual({ ok: false, cause: SIM_EXPIRED_CAUSE });
  });
});

describe("public RPC only", () => {
  it("the empty env the simulation uses resolves to public mainnet only (process env and paid providers are never read)", async () => {
    const { resolveRpcPool, PUBLIC_SOLANA_RPC_URL } = await import("@sofinance/engine/rpc");
    expect(resolveRpcPool({}).transaction.map((member) => member.endpoint)).toEqual([PUBLIC_SOLANA_RPC_URL]);
  });
});

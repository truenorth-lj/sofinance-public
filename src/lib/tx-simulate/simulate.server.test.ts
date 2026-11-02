import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { buildTransaction, testKeypair } from "@/lib/test-support/send-fixtures";
import { simulateBeforeWallet } from "./simulate.server";
import { SIM_EXPIRED_CAUSE, SIM_SLIPPAGE_CAUSE } from "./cause";

const tx = () => buildTransaction({ payer: testKeypair(31), signWith: [] });
type Conn = NonNullable<NonNullable<Parameters<typeof simulateBeforeWallet>[1]>["connection"]> & { simulateTransaction: ReturnType<typeof vi.fn> };
const connection = (impl: () => Promise<unknown>, height = 100) =>
  ({ simulateTransaction: vi.fn(impl), getBlockHeight: vi.fn(async () => height) }) as never as Conn;
const sim = (conn: Conn, lastValidBlockHeight?: number) => simulateBeforeWallet(tx(), { connection: conn, lastValidBlockHeight });

describe("simulateBeforeWallet", () => {
  it("simulates the exact bytes without signature checks and keeps the real blockhash", async () => {
    const conn = connection(async () => ({ value: { err: null, logs: [], unitsConsumed: 1234 } }));
    expect(await sim(conn)).toEqual({ ok: true, unitsConsumed: 1234 });
    expect(conn.simulateTransaction.mock.calls[0]![1]).toMatchObject({ sigVerify: false, replaceRecentBlockhash: false });
  });
  it("returns the plain cause of a failed simulation", async () => {
    const conn = connection(async () => ({ value: { err: { InstructionError: [1, { Custom: 6001 }] }, logs: ["Program log: Error: SlippageToleranceExceeded"] } }));
    expect(await sim(conn)).toEqual({ ok: false, cause: SIM_SLIPPAGE_CAUSE });
  });
  it("treats an RPC error as unavailable, except an expired blockhash", async () => {
    expect(await sim(connection(async () => { throw new Error("429 Too Many Requests"); }))).toEqual({ ok: null, unavailable: true });
    expect(await sim(connection(async () => { throw new Error("Blockhash not found"); }))).toEqual({ ok: false, cause: SIM_EXPIRED_CAUSE });
  });
});

describe("expired blockhash", () => {
  it("refuses once the prepared lastValidBlockHeight has passed, without simulating", async () => {
    const conn = connection(async () => ({ value: { err: null, logs: [] } }), 501);
    expect(await sim(conn, 500)).toEqual({ ok: false, cause: SIM_EXPIRED_CAUSE });
    expect(conn.simulateTransaction).not.toHaveBeenCalled();
  });
  it("simulates while the blockhash is still valid", async () => {
    const conn = connection(async () => ({ value: { err: null, logs: [] } }), 500);
    expect(await sim(conn, 500)).toEqual({ ok: true });
  });
});

describe("public RPC only", () => {
  it("the empty env the simulation uses resolves to public mainnet only (process env and paid providers are never read)", async () => {
    const { resolveRpcPool, PUBLIC_SOLANA_RPC_URL } = await import("@sofinance/engine/rpc");
    expect(resolveRpcPool({}).transaction.map((member) => member.endpoint)).toEqual([PUBLIC_SOLANA_RPC_URL]);
  });
});

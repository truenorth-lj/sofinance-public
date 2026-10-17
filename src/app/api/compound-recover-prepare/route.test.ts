import { beforeEach, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { buildAndSimulateCompoundRecovery } from "@sofinance/engine/compound-recovery";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({ accounts: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/compound-recovery", () => ({ buildAndSimulateCompoundRecovery: vi.fn() }));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: () => ({ getMultipleAccountsInfo: mocks.accounts }) }));
vi.mock("@/lib/api-response", () => ({ apiError: () => Response.json({ error: "Preparation failed" }, { status: 400 }) }));
const wallet = Keypair.generate().publicKey.toBase58();
const accounts = [{ address: Keypair.generate().publicKey.toBase58() }, { address: Keypair.generate().publicKey.toBase58() }];
const request = () => new Request("http://localhost/api/compound-recover-prepare", { method: "POST",
  body: JSON.stringify({ wallet, compoundAccounts: accounts }) });
const absent = () => new Error("No recoverable yield accounts; please verify original compound transaction status first");
beforeEach(() => vi.resetAllMocks());

it("skips a stale receipt only after builder validation and a finalized absence read", async () => {
  vi.mocked(buildAndSimulateCompoundRecovery).mockRejectedValue(absent());
  mocks.accounts.mockResolvedValue([null, null]);
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ alreadyClosed: true, wallet, accounts: accounts.map(account => account.address) });
  expect(mocks.accounts).toHaveBeenCalledWith(expect.any(Array), "finalized");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});
it.each(["balance mismatch", "RPC unavailable", "Invalid yield account seed or program"])("never treats %s as already cleaned", async message => {
  vi.mocked(buildAndSimulateCompoundRecovery).mockRejectedValue(new Error(message));
  expect((await POST(request())).status).toBe(400);
  expect(mocks.accounts).not.toHaveBeenCalled();
});
it("does not skip when a source survives or finalized readback is incomplete", async () => {
  vi.mocked(buildAndSimulateCompoundRecovery).mockRejectedValue(absent());
  for (const value of [[null, { lamports: 1 }], [null]]) {
    mocks.accounts.mockResolvedValue(value);
    expect((await POST(request())).status).toBe(400);
  }
});
it("does not skip when finalized absence cannot be verified", async () => {
  vi.mocked(buildAndSimulateCompoundRecovery).mockRejectedValue(absent());
  mocks.accounts.mockRejectedValue(new Error("RPC unavailable"));
  expect((await POST(request())).status).toBe(400);
});

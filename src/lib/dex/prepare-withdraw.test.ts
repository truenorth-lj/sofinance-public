import { beforeEach, expect, it, vi } from "vitest";
import type { WithdrawPrepareRequest, WithdrawPrepared } from "@sofinance/engine/withdraw/types";
import { prepareWithdrawal, quoteWithdrawal } from "./prepare-withdraw.server";
import { APP_WITHDRAW_PREPARE, MCP_WITHDRAW_PREPARE } from "./withdraw-prepare";
import { createDexRegistry } from "./registry";
import { fakeSolanaModule } from "./__contract__/testing/fake-dex";

vi.mock("server-only", () => ({}));
const backend = vi.hoisted(() => ({ build: vi.fn(), refresh: vi.fn(), permits: vi.fn() }));
vi.mock("./registry-instance", () => ({ dexRegistry: { buildWithdrawal: backend.build } }));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: () => ({}) }));
vi.mock("@/lib/withdraw/fresh-prepare", () => ({ refreshWithdrawBlockhash: backend.refresh }));
vi.mock("@/lib/tx-send/permit", () => ({ txPermitsFor: backend.permits }));
const request = () => ({ wallet: "owner", positionMint: "nft", percent: 50, receive: "original" as const });
const prepared = { summary: { stage: "withdraw", lastValidBlockHeight: 100, assets: [{ amount: "9007199254740993" }] },
  unsignedTransaction: "first-transaction", permit: "signed-first-stage" } as WithdrawPrepared;
const fresh = { ...prepared, unsignedTransaction: "fresh-transaction", permit: "fresh-permit",
  summary: { ...prepared.summary, lastValidBlockHeight: 200 } };
beforeEach(() => {
  vi.resetAllMocks(); backend.build.mockResolvedValue(prepared); backend.refresh.mockResolvedValue(fresh);
  backend.permits.mockReturnValue({ sendPermit: "send", landedPermit: "landed" });
});

it("keeps app retries, freshness and relay permits bound to the returned bytes", async () => {
  backend.build.mockRejectedValueOnce(new Error("Wallet token balance changed; prepare again"));
  expect(await prepareWithdrawal("raydium-clmm", request(), APP_WITHDRAW_PREPARE))
    .toEqual({ ...fresh, sendPermit: "send", landedPermit: "landed" });
  expect(backend.build).toHaveBeenCalledTimes(2);
  expect(backend.refresh).toHaveBeenCalledWith({}, prepared);
  expect(backend.permits).toHaveBeenCalledWith("owner", "fresh-transaction", 200);
});

it("does not retry or restamp the MCP authorization", async () => {
  expect(await prepareWithdrawal("raydium-clmm", request(), MCP_WITHDRAW_PREPARE)).toBe(prepared);
  expect(backend.refresh).not.toHaveBeenCalled(); expect(backend.permits).not.toHaveBeenCalled();
  backend.build.mockRejectedValue(new Error("Wallet token balance changed; prepare again"));
  await expect(prepareWithdrawal("raydium-clmm", request(), MCP_WITHDRAW_PREPARE)).rejects.toThrow("prepare again");
  expect(backend.build).toHaveBeenCalledTimes(2);
});

it("never retries a rejected recovery receipt or issues a relay permit", async () => {
  backend.build.mockRejectedValue(new Error("First transaction must be finalized and match the prepared withdrawal"));
  await expect(prepareWithdrawal("raydium-clmm", request(), APP_WITHDRAW_PREPARE)).rejects.toThrow("must be finalized");
  expect(backend.build).toHaveBeenCalledTimes(1); expect(backend.refresh).not.toHaveBeenCalled();
  expect(backend.permits).not.toHaveBeenCalled();
});

it("keeps preview confirmation bypass and exposes only the summary", async () => {
  expect(await quoteWithdrawal("raydium-clmm", request())).toBe(prepared.summary);
  expect(backend.build).toHaveBeenCalledWith("raydium-clmm", request(), true);
  expect(backend.refresh).not.toHaveBeenCalled(); expect(backend.permits).not.toHaveBeenCalled();
});

it("snapshots initiating identity and nested first-stage authorization across app retries", async () => {
  let release!: () => void;
  backend.build.mockImplementationOnce(() => new Promise((_resolve, reject) => {
    release = () => reject(new Error("Wallet token balance changed; prepare again"));
  }));
  const input: WithdrawPrepareRequest = { ...request(), stage: "swap", tx1Signature: "finalized-signature", previous: structuredClone(prepared) };
  const original = structuredClone(input);
  const pending = prepareWithdrawal("raydium-clmm", input, APP_WITHDRAW_PREPARE);
  input.wallet = "stranger"; input.previous!.summary.assets[0]!.amount = "1";
  input.previous!.permit = "replacement"; input.tx1Signature = "different-signature";
  release(); await pending;
  expect(backend.build).toHaveBeenNthCalledWith(2, "raydium-clmm", original);
  expect(backend.permits).toHaveBeenCalledWith("owner", "fresh-transaction", 200);
});

it("requires an explicit native binding independently of generic rollout, and clones before lazy loading", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let received: unknown;
  const registry = createDexRegistry([{ ...fakeSolanaModule, descriptor: { ...fakeSolanaModule.descriptor, nativeCapabilities: { open: fakeSolanaModule.descriptor.capabilities.open, positions: fakeSolanaModule.descriptor.capabilities },
    capabilities: { ...fakeSolanaModule.descriptor.capabilities, withdraw: { supported: false, reason: "Generic recovery unavailable" } } }, enabled: () => false,
    buildWithdrawal: async input => { await gate; received = input; return prepared; } }]);
  const input = { ...request(), previous: structuredClone(prepared) };
  const original = structuredClone(input);
  const pending = registry.buildWithdrawal(fakeSolanaModule.descriptor.id, input);
  input.previous.permit = "replacement"; input.previous.summary.assets[0]!.amount = "1";
  release(); await pending;
  expect(received).toEqual(original);
  expect(registry.isDisabled(fakeSolanaModule.descriptor.id, "withdraw")).toBe(true);
  await expect(registry.buildWithdrawal("unknown", request())).rejects.toMatchObject({ code: "UNSUPPORTED" });
  await expect(createDexRegistry([fakeSolanaModule]).buildWithdrawal(fakeSolanaModule.descriptor.id, request()))
    .rejects.toMatchObject({ code: "UNSUPPORTED" });
});

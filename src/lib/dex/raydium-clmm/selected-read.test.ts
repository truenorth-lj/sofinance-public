import { beforeEach, expect, it, vi } from "vitest";
import type { Connection } from "@solana/web3.js";
import { quoteRaydiumAdd } from "./quote-add.server";
import { readRaydiumAddState } from "./read-add-state.server";
vi.mock("server-only", () => ({}));
const backend = vi.hoisted(() => ({ quote: vi.fn(), state: vi.fn(), readConnection: {} }));
vi.mock("@/lib/selected-quote", () => ({ searchSelectedQuoteBundle: backend.quote }));
vi.mock("@sofinance/engine/selected-state", () => ({ readSelectedPositionState: backend.state }));
vi.mock("@sofinance/engine/rpc", () => ({ rpcReadConnection: () => backend.readConnection }));
vi.mock("@sofinance/engine/config/server-env", async original => ({
  ...await original<typeof import("@sofinance/engine/config/server-env")>(),
  getSigningSecret: () => { throw new Error("Read-only paths must not read signing keys"); },
}));
const command = { wallet: "owner", selection: { positionMint: "nft", inputMint: "mint", inputKind: "token" as const },
  amount: "1", floorBps: 9900, toleranceBps: 200 };
const quote = { requested: "9007199254740993" };
beforeEach(() => { vi.resetAllMocks(); backend.quote.mockResolvedValue({ quote, legs: ["private-build-data"], state: { internal: true } }); });

it("keeps MCP's exact six-argument quote-only call and returns only the existing quote DTO", async () => {
  expect(await quoteRaydiumAdd(command)).toBe(quote);
  expect(backend.quote).toHaveBeenCalledWith("owner", command.selection, "1", 9900, 200, { buildTransactions: false, includeResale: false });
});
it("retains the app connection, signal and mutable retry budget", async () => {
  const context = { signal: new AbortController().signal, budget: { deadlineAt: 100, retriesLeft: 1 }, connection: {} as Connection };
  expect(await quoteRaydiumAdd(command, context)).toBe(quote);
  const options = backend.quote.mock.calls[0]![5];
  expect(options).toEqual({ buildTransactions: false, includeResale: false, ...context });
  expect(options.signal).toBe(context.signal); expect(options.budget).toBe(context.budget); expect(options.connection).toBe(context.connection);
});
it("uses the read RPC with the original state defaults and error identity", async () => {
  const state = { wallet: "owner", pricing: { priceUsdInput: 1 } };
  backend.state.mockResolvedValueOnce(state);
  expect(await readRaydiumAddState(command)).toBe(state);
  expect(backend.state).toHaveBeenCalledWith("owner", command.selection, backend.readConnection);
  const error = new Error("Position state no longer held"); backend.state.mockRejectedValueOnce(error);
  await expect(readRaydiumAddState(command)).rejects.toBe(error);
});

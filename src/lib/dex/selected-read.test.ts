import { expect, it, vi } from "vitest";
import type { Connection } from "@solana/web3.js";
import type { SelectedQuote } from "@/lib/selected-quote-types";
import type { SelectedPositionState } from "@sofinance/engine/selected-types";
import { createDexRegistry } from "./registry";
import type { AddQuoteContext } from "./selected-read";
import { fakeSolanaModule } from "./__contract__/testing/fake-dex";
const request = () => ({ wallet: "owner", selection: { positionMint: "nft", inputMint: "mint", inputKind: "token" as const },
  amount: "1.000001", floorBps: 9900, toleranceBps: 200 });
const quote = { requested: "9007199254740993" } as SelectedQuote;
const state = { wallet: "owner", positionMint: "nft" } as SelectedPositionState;
const id = fakeSolanaModule.descriptor.id;
function scope(): AddQuoteContext { return { signal: new AbortController().signal,
  budget: { deadlineAt: Date.now() + 8000, retriesLeft: 1 }, connection: {} as Connection }; }

it("snapshots quote terms before lazy load while preserving request-scope references", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let received: { command: unknown; context: AddQuoteContext | undefined } | undefined;
  const registry = createDexRegistry([{ ...fakeSolanaModule, quoteAdd: async (command, context) => {
    await gate; received = { command, context }; return quote;
  } }]);
  const command = request(), context = scope(), original = { ...context };
  const pending = registry.quoteAdd(id, command, context);
  command.wallet = "other"; command.selection.positionMint = "other-nft"; command.amount = "999"; command.floorBps = 0;
  context.signal = new AbortController().signal; context.budget = { deadlineAt: 1, retriesLeft: 0 }; context.connection = {} as Connection;
  original.budget.retriesLeft = 0;
  release(); expect(await pending).toBe(quote);
  expect(received!.command).toEqual(request());
  expect(received!.context!.signal).toBe(original.signal);
  expect(received!.context!.budget).toBe(original.budget);
  expect(received!.context!.budget.retriesLeft).toBe(0);
  expect(received!.context!.connection).toBe(original.connection);
});

it("does not invoke a quote binding for a cancelled scope", async () => {
  const backend = vi.fn().mockResolvedValue(quote), controller = new AbortController(), error = new Error("cancelled");
  controller.abort(error);
  const registry = createDexRegistry([{ ...fakeSolanaModule, quoteAdd: backend }]);
  await expect(registry.quoteAdd(id, request(), { ...scope(), signal: controller.signal })).rejects.toBe(error);
  expect(backend).not.toHaveBeenCalled();
});

it("never returns a quote completed after cancellation", async () => {
  let release!: () => void;
  const backend = vi.fn(() => new Promise<SelectedQuote>(resolve => { release = () => resolve(quote); }));
  const controller = new AbortController(), error = new Error("cancelled");
  const registry = createDexRegistry([{ ...fakeSolanaModule, quoteAdd: backend }]);
  const pending = registry.quoteAdd(id, request(), { ...scope(), signal: controller.signal });
  controller.abort(error); release();
  await expect(pending).rejects.toBe(error);
});

it("snapshots state identity before lazy load and preserves reader errors unchanged", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let received: unknown;
  const backend = vi.fn(async command => { await gate; received = command; return state; });
  const registry = createDexRegistry([{ ...fakeSolanaModule, readAddState: backend }]);
  const command = request(), expected = request();
  const pending = registry.readAddState(id, command);
  command.wallet = "other"; command.selection.inputMint = "other";
  release(); expect(await pending).toBe(state); expect(received).toEqual(expected);
  const error = new Error("Selected position NFT is not held by the connected wallet");
  backend.mockRejectedValueOnce(error);
  await expect(registry.readAddState(id, request())).rejects.toBe(error);
});

it("requires explicit bindings and refuses new quotes by native policy while leaving state readable", async () => {
  const backend = vi.fn().mockResolvedValue(quote), reader = vi.fn().mockResolvedValue(state);
  const descriptor = { ...fakeSolanaModule.descriptor, nativeCapabilities: { open: fakeSolanaModule.descriptor.capabilities.open,
    positions: { ...fakeSolanaModule.descriptor.capabilities, deposit: { supported: false as const, reason: "Unavailable" } } } };
  const registry = createDexRegistry([{ ...fakeSolanaModule, descriptor, enabled: () => false, quoteAdd: backend, readAddState: reader }]);
  await expect(registry.quoteAdd(id, request())).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(backend).not.toHaveBeenCalled();
  await expect(registry.readAddState(id, request())).resolves.toBe(state);
  expect(registry.isDisabled(id, "quote-add")).toBe(true);
  const absent = createDexRegistry([fakeSolanaModule]);
  for (const candidate of [id, "unknown"]) {
    await expect(absent.quoteAdd(candidate, request())).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(absent.readAddState(candidate, request())).rejects.toMatchObject({ code: "UNSUPPORTED" });
  }
});

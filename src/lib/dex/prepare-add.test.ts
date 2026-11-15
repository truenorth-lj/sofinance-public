import { beforeEach, expect, expectTypeOf, it, vi } from "vitest";
import type { PositionSelection } from "@sofinance/engine/selected-state";
import { buildTransaction, testKeypair, SIGNING_SECRET } from "@/lib/test-support/send-fixtures";
import { verifySelectedPermit } from "@/lib/selected-permit";
import { prepareAdd } from "./prepare-add.server";
import { APP_ADD_PREPARE, MCP_ADD_PREPARE, type AddPrepareCommand, type BuildAdd } from "./add-prepare";
import { createDexRegistry } from "./registry";
import { fakeSolanaModule } from "./__contract__/testing/fake-dex";

vi.mock("server-only", () => ({}));
const backend = vi.hoisted(() => ({ buildAdd: vi.fn() }));
vi.mock("./registry-instance", () => ({ dexRegistry: { buildAdd: backend.buildAdd } }));

const transaction = buildTransaction({ payer: testKeypair(1), signWith: [] });
const wallet = testKeypair(1).publicKey.toBase58();
const original = () => ({ wallet, selection: { positionMint: testKeypair(2).publicKey.toBase58(), inputMint: testKeypair(3).publicKey.toBase58(), inputKind: "token" as const },
  amount: "1", floorBps: 9900, toleranceBps: 200 });
const summary = { quote: { requested: "1000000", liquidity: "50", floorBps: 9900, rangeSide: "inside" },
  startingLiquidity: "10", startingBalances: { input: "1000000", a: "1", b: "2" }, expiresAt: Date.now() + 75000, lastValidBlockHeight: 200 };

beforeEach(() => { backend.buildAdd.mockReset(); backend.buildAdd.mockResolvedValue({ transaction, summary }); });

it("keeps the compatibility selection identical to the engine's selection contract", () => {
  expectTypeOf<AddPrepareCommand["selection"]>().toEqualTypeOf<PositionSelection>();
});

it("retains the initiating identity and terms across the lazy build await", async () => {
  let release!: () => void;
  backend.buildAdd.mockImplementation(() => new Promise(resolve => { release = () => resolve({ transaction, summary }); }));
  const command = original();
  const pending = prepareAdd("raydium-clmm", command, () => SIGNING_SECRET, MCP_ADD_PREPARE);
  command.wallet = testKeypair(9).publicKey.toBase58(); command.selection.positionMint = testKeypair(10).publicKey.toBase58();
  command.amount = "2"; command.floorBps = 9500; command.toleranceBps = 500;
  release();
  const prepared = await pending;
  expect(backend.buildAdd).toHaveBeenCalledWith("raydium-clmm", original());
  expect(prepared.submitArgs.wallet).toBe(wallet);
  expect(prepared.submitArgs.selection).toEqual(original().selection);
  expect(verifySelectedPermit(SIGNING_SECRET, { ...prepared.submitArgs, message: Buffer.from(transaction.message.serialize()).toString("base64") }, prepared.permit)).toBe(true);
});

it("does not load a module or read a secret for an already cancelled app request", async () => {
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  const secret = vi.fn(() => SIGNING_SECRET);
  await expect(prepareAdd("raydium-clmm", original(), secret, APP_ADD_PREPARE,
    { signal: controller.signal, budget: { deadlineAt: Date.now() + 8000, retriesLeft: 1 } })).rejects.toThrow("cancelled");
  expect(backend.buildAdd).not.toHaveBeenCalled(); expect(secret).not.toHaveBeenCalled();
});

it("dispatches only a registered, deposit-capable binding, independently of generic HTTP rollout", async () => {
  const buildAdd = vi.fn().mockResolvedValue({ transaction, summary });
  const registry = createDexRegistry([{ ...fakeSolanaModule, enabled: () => false, buildAdd }]);
  expect(registry.isDisabled(fakeSolanaModule.descriptor.id, "add")).toBe(true);
  await expect(registry.buildAdd(fakeSolanaModule.descriptor.id, original())).resolves.toEqual({ transaction, summary });
  await expect(registry.buildAdd("unknown", original())).rejects.toMatchObject({ code: "UNSUPPORTED" });
  const absent = createDexRegistry([fakeSolanaModule]);
  await expect(absent.buildAdd(fakeSolanaModule.descriptor.id, original())).rejects.toMatchObject({ code: "UNSUPPORTED" });
  const unsupported = createDexRegistry([{ ...fakeSolanaModule, descriptor: { ...fakeSolanaModule.descriptor,
    capabilities: { ...fakeSolanaModule.descriptor.capabilities, deposit: { supported: false, reason: "Not supported" } } }, buildAdd }]);
  await expect(unsupported.buildAdd(fakeSolanaModule.descriptor.id, original())).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(buildAdd).toHaveBeenCalledTimes(1);
});

it("binds simulation input and policy before a module's lazy load", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let received: unknown;
  const registry = createDexRegistry([{ ...fakeSolanaModule, buildAdd: async (command, options) => {
    await gate; received = { command, options }; return { transaction, summary } as Awaited<ReturnType<BuildAdd>>;
  } }]);
  const command = original(); const options = { enforceResaleFloor: false };
  const pending = registry.buildAdd(fakeSolanaModule.descriptor.id, command, options);
  command.selection.positionMint = testKeypair(11).publicKey.toBase58(); command.amount = "2";
  options.enforceResaleFloor = true;
  release(); await pending;
  expect(received).toEqual({ command: original(), options: { enforceResaleFloor: false } });
});

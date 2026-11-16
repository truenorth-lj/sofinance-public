import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { MAX_POSITION_LOOKUP } from "@sofinance/engine/protocols/uniswap-v4/exit-flow";
import { createDexRegistry } from "./registry";
import { uniswapV4RhcModule } from "./uniswap-v4-rhc/module";
import { EvmLiquidityInputError, evmLiquiditySchemasFor, runEvmOpen, runEvmExit } from "./index";
import { POST as openPost } from "@/app/api/rhc-univ4-open/route";
import { POST as exitPost } from "@/app/api/rhc-univ4-exit/route";

vi.mock("server-only", () => ({}));
const backend = vi.hoisted(() => ({ prepare: vi.fn(), finalize: vi.fn(), positions: vi.fn(), exit: vi.fn(), client: vi.fn() }));
vi.mock("@sofinance/engine/protocols/uniswap-v4/open-flow", async original => ({
  ...await original<typeof import("@sofinance/engine/protocols/uniswap-v4/open-flow")>(),
  prepareOpen: backend.prepare, finalizeOpen: backend.finalize,
}));
vi.mock("@sofinance/engine/protocols/uniswap-v4/exit-flow", async original => ({
  ...await original<typeof import("@sofinance/engine/protocols/uniswap-v4/exit-flow")>(),
  lookupPositions: backend.positions, prepareExit: backend.exit,
}));
vi.mock("@sofinance/engine/rpc-evm/index", () => ({ createRhcClient: backend.client }));

const USER = "0xab9069703d7df7c4a472bc634312f087f0b9b320";
const TOKEN = "0x4a0E65A3ecceC6dBE60aE065F2e7bB85faE35eEa";
const POOL = "0x4f54c74021e4139bbc4c7bc924346c921975136ea120cf118a93c43b50bdbd3c";
const FEE = "0x00000000000000000000000000000000000Fee01";
const client = { marker: "shared state client" };
const input = { action: "prepare", poolId: POOL, user: USER, depositToken: TOKEN,
  amount: "9007199254740993", tickLower: -11, tickUpper: 9 };
const finalizeInput = { ...input, action: "finalize", attempt: 2, signature: `0x${"ab".repeat(65)}`,
  permit: { details: { token: TOKEN, amount: "9007199254740993", expiration: 123, nonce: 7 },
    spender: "0x204FAca1764B154221e35c0d20aBb3c525710498", sigDeadline: "9007199254740993" } };
const post = (handler: typeof openPost, body: unknown) => handler(new Request("https://example.test/api/native", {
  method: "POST", body: JSON.stringify(body),
}));
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("VERCEL_ENV", "production"); vi.stubEnv("RHC_UNIV4_FEE_WALLET", FEE);
  backend.client.mockReturnValue(client);
  backend.prepare.mockResolvedValue({ state: "failed", code: "fee-wallet-unconfigured", message: "Fee wallet not configured; opening is disabled" });
  backend.finalize.mockResolvedValue({ state: "failed", code: "guard", message: "test guard" });
  backend.positions.mockResolvedValue([]); backend.exit.mockResolvedValue({ state: "failed", code: "not-owner", message: "test owner" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("keeps exact decimal strings and nested Permit2 terms across the lazy open await", async () => {
  const command = evmLiquiditySchemasFor("uniswap-v4-rhc").open.parse(finalizeInput);
  if (command.action !== "finalize") throw new Error("fixture");
  const original = structuredClone(command), pending = runEvmOpen("uniswap-v4-rhc", command);
  command.user = TOKEN; command.poolId = `0x${"11".repeat(32)}`; command.amount = "1";
  command.depositToken = USER; command.tickLower = -100; command.tickUpper = 100;
  command.signature = `0x${"cd".repeat(65)}`; command.attempt = 9;
  command.permit.details.amount = "1"; command.permit.details.token = USER; command.permit.details.nonce = 8;
  command.permit.spender = USER; command.permit.sigDeadline = "1";
  const result = await pending;
  expect(result).toEqual({ state: "failed", code: "guard", message: "test guard" });
  expect(backend.finalize).toHaveBeenCalledExactlyOnceWith({ client, feeRecipient: FEE }, {
    pool: expect.objectContaining({ poolId: POOL }), user: original.user, depositToken: getAddress(TOKEN),
    amount: 9007199254740993n, tickLower: -11, tickUpper: 9, attempt: 2, signature: original.signature,
    permit: { details: { ...original.permit.details, amount: 9007199254740993n },
      spender: original.permit.spender, sigDeadline: 9007199254740993n },
  });
  expect(backend.prepare).not.toHaveBeenCalled();
});

it("preserves prepare terms and native HTTP failure statuses without generic capabilities", async () => {
  const registry = createDexRegistry([uniswapV4RhcModule]);
  expect(registry.isDisabled("uniswap-v4-rhc", "open")).toBe(true);
  expect(registry.descriptorFor("uniswap-v4-rhc")?.capabilities.open.supported).toBe(false);
  const command = evmLiquiditySchemasFor("uniswap-v4-rhc").open.parse(input);
  const pending = runEvmOpen("uniswap-v4-rhc", command);
  command.amount = "1"; command.user = TOKEN; command.tickLower = -100;
  await pending;
  expect(backend.prepare).toHaveBeenCalledExactlyOnceWith({ client, feeRecipient: FEE }, {
    pool: expect.objectContaining({ poolId: POOL }), user: getAddress(USER), depositToken: getAddress(TOKEN),
    amount: 9007199254740993n, tickLower: -11, tickUpper: 9,
  });
  const response = await post(openPost, input);
  expect(response.status).toBe(422); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ state: "failed", code: "fee-wallet-unconfigured", message: "Fee wallet not configured; opening is disabled" });
});

it("captures exit owner and token ids before lazy position lookup and retains no-fee prepare", async () => {
  const schema = evmLiquiditySchemasFor("uniswap-v4-rhc").exit;
  const command = schema.parse({ action: "positions", user: USER, tokenIds: ["9007199254740993", "1"] });
  if (command.action !== "positions") throw new Error("fixture");
  const pending = runEvmExit("uniswap-v4-rhc", command);
  command.user = TOKEN; command.tokenIds[0] = "2"; command.tokenIds.push("3");
  expect(await pending).toEqual({ state: "positions", positions: [] });
  expect(backend.positions).toHaveBeenCalledExactlyOnceWith(client, getAddress(USER), [9007199254740993n, 1n]);
  const prepare = schema.parse({ action: "prepare", user: USER, tokenId: "9007199254740993" });
  if (prepare.action !== "prepare") throw new Error("fixture");
  const exit = runEvmExit("uniswap-v4-rhc", prepare);
  prepare.user = TOKEN; prepare.tokenId = "1";
  await exit;
  expect(backend.exit).toHaveBeenCalledExactlyOnceWith({ client, feeRecipient: FEE }, { user: getAddress(USER), tokenId: 9007199254740993n });
});

it("shares the engine lookup limit and preserves strict schemas, checksum normalization and boundary validation", () => {
  const { open, exit } = evmLiquiditySchemasFor("uniswap-v4-rhc");
  expect(open.parse(input)).toMatchObject({ user: getAddress(USER), amount: "9007199254740993" });
  expect(exit.safeParse({ action: "positions", user: USER, tokenIds: Array(MAX_POSITION_LOOKUP).fill("1") }).success).toBe(true);
  expect(exit.safeParse({ action: "positions", user: USER, tokenIds: Array(MAX_POSITION_LOOKUP + 1).fill("1") }).success).toBe(false);
  for (const extra of [{ stateOverrides: {} }, { recipient: USER }, { dex: "raydium-clmm" }]) {
    expect(open.safeParse({ ...input, ...extra }).success).toBe(false);
    expect(exit.safeParse({ action: "prepare", user: USER, tokenId: "1", ...extra }).success).toBe(false);
  }
  for (const change of [{ amount: "1".repeat(79) }, { tickLower: -887273 }, { tickUpper: 887273 }, { tickLower: 1.5 }])
    expect(open.safeParse({ ...input, ...change }).success).toBe(false);
  expect(open.safeParse({ ...finalizeInput, permit: { ...finalizeInput.permit, details: { ...finalizeInput.permit.details, extra: true } } }).success).toBe(false);
  expect(open.safeParse({ ...finalizeInput, permit: { ...finalizeInput.permit, extra: true } }).success).toBe(false);
  expect(open.safeParse({ ...finalizeInput, attempt: 11 }).success).toBe(false);
  expect(exit.safeParse({ action: "prepare", user: USER, tokenId: "1".repeat(31) }).success).toBe(false);
});

it("rejects disabled or missing native bindings before backend work, independently of generic write admission", async () => {
  const binding = uniswapV4RhcModule.evmLiquidity!;
  const registry = createDexRegistry([{ ...uniswapV4RhcModule, evmLiquidity: { ...binding, enabled: () => false } }]);
  const open = binding.schemas.open.parse(input), exit = binding.schemas.exit.parse({ action: "prepare", user: USER, tokenId: "1" });
  await expect(registry.runEvmOpen("uniswap-v4-rhc", open)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  await expect(registry.runEvmExit("uniswap-v4-rhc", exit)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  for (const id of ["unknown", "raydium-clmm"]) {
    expect(() => registry.evmLiquiditySchemasFor(id)).toThrow(/not available/i);
    await expect(registry.runEvmOpen(id, open)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(registry.runEvmExit(id, exit)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  }
  expect(backend.prepare).not.toHaveBeenCalled(); expect(backend.finalize).not.toHaveBeenCalled();
  expect(backend.exit).not.toHaveBeenCalled(); expect(backend.positions).not.toHaveBeenCalled();
});

it("keeps validation failures at 400 and upstream exceptions at 503 with no-store", async () => {
  const invalid = await post(openPost, { ...input, poolId: `0x${"11".repeat(32)}` });
  expect(invalid.status).toBe(400); expect(await invalid.json()).toEqual({ error: "Pool is not allowlisted" });
  expect(backend.prepare).not.toHaveBeenCalled();
  expect(EvmLiquidityInputError.prototype).toBeInstanceOf(Error);
  backend.prepare.mockRejectedValueOnce(new Error("RPC unavailable"));
  const failedOpen = await post(openPost, input);
  expect(failedOpen.status).toBe(503); expect(failedOpen.headers.get("Cache-Control")).toBe("no-store");
  backend.exit.mockRejectedValueOnce(new Error("RPC unavailable"));
  const failedExit = await post(exitPost, { action: "prepare", user: USER, tokenId: "1" });
  expect(failedExit.status).toBe(503); expect(failedExit.headers.get("Cache-Control")).toBe("no-store");
});

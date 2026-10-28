import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const backend = vi.hoisted(() => ({ build: vi.fn(), secret: vi.fn() }));
vi.mock("@/lib/selected-atomic", () => ({ buildAndSimulateSelectedZap: backend.build }));
vi.mock("@sofinance/engine/compound-atomic", () => ({ buildAndSimulateCompound: backend.build }));
vi.mock("@sofinance/engine/open-atomic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sofinance/engine/open-atomic")>()),
  buildAndSimulateOpenPosition: backend.build,
}));
vi.mock("@sofinance/engine/config/server-env", async original => ({
  ...await original<typeof import("@sofinance/engine/config/server-env")>(), getSigningSecret: backend.secret,
}));
import { buildTransaction, SIGNING_SECRET, testKeypair } from "@/lib/test-support/send-fixtures";
import { verifySignToken } from "@/lib/pending-sign-token";
import { prepareTransaction, prepareCompoundTransaction, prepareOpenPosition } from "./tools";
import { prepareTransactionSchema, quoteCompoundSchema, prepareOpenPositionSchema } from "./schemas";
import { VALID_ARGS } from "./test-support/dispatch-fixtures";
const operations = [
  () => prepareTransaction(prepareTransactionSchema.parse(VALID_ARGS.prepare_transaction)),
  () => prepareCompoundTransaction(quoteCompoundSchema.parse(VALID_ARGS.prepare_compound_transaction)),
  () => prepareOpenPosition(prepareOpenPositionSchema.parse(VALID_ARGS.prepare_open_position)),
];
beforeEach(() => {
  vi.resetAllMocks(); backend.secret.mockReturnValueOnce(SIGNING_SECRET).mockReturnValue("rotated-after-prepare");
  backend.build.mockResolvedValue({
    transaction: buildTransaction({ payer: testKeypair(1), signWith: [] }),
    summary: { quote: { requested: "1", floorBps: 9900, liquidity: "1", rangeSide: "inside" },
      startingLiquidity: "1", startingBalances: { input: "1", a: "0", b: "0" }, expiresAt: Date.now() + 60000, lastValidBlockHeight: 150 },
  });
});
afterEach(() => vi.restoreAllMocks());
for (const [index, prepare] of operations.entries()) {
  it(`prepare ${index} captures one signing key after building for both permit and token`, async () => {
    const result = await prepare();
    expect(backend.secret).toHaveBeenCalledOnce();
    expect(backend.build.mock.invocationCallOrder[0]!).toBeLessThan(backend.secret.mock.invocationCallOrder[0]!);
    expect(await verifySignToken(result.signToken, SIGNING_SECRET)).toMatchObject({ permit: result.permit });
    expect(await verifySignToken(result.signToken, "rotated-after-prepare")).toBeNull();
  });
  it(`prepare ${index} does not read a signing key when the builder rejects`, async () => {
    backend.build.mockRejectedValue(new Error("builder rejected"));
    await expect(prepare()).rejects.toThrow("builder rejected"); expect(backend.secret).not.toHaveBeenCalled();
  });
}

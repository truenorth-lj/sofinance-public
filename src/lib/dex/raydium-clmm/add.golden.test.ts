import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_ADD_TOLERANCE_BPS, DEFAULT_RESALE_FLOOR_BPS, USDC_MINT } from "@sofinance/engine/ids";
import { buildAndSimulateSelectedZap } from "@/lib/selected-atomic";
import { createRaydiumAddChain, FEE_WALLET, OWNER, POSITION_MINT } from "./raydium-clmm.fixtures";
import { createRaydiumClmmAdapter } from "./adapter.server";
import { raydiumClmmFixtures } from "./raydium-clmm.fixtures";

vi.mock("server-only", () => ({}));
const current = vi.hoisted(() => ({ chain: undefined as unknown as ReturnType<typeof createRaydiumAddChain> }));
vi.mock("@sofinance/engine/rpc", async (original) => ({
  ...await original<typeof import("@sofinance/engine/rpc")>(), rpcConnection: () => current.chain.connection,
}));
beforeEach(() => {
  current.chain = createRaydiumAddChain();
  vi.stubEnv("SOFINANCE_FEE_WALLET", FEE_WALLET); vi.stubEnv("SOFINANCE_FEE_BPS", "10");
});
afterEach(() => vi.unstubAllEnvs());
it("records the existing app add transaction before wiring the registry adapter", async () => {
  const { transaction, summary } = await buildAndSimulateSelectedZap(OWNER,
    { positionMint: POSITION_MINT, inputMint: USDC_MINT, inputKind: "token" }, "1", DEFAULT_RESALE_FLOOR_BPS, DEFAULT_ADD_TOLERANCE_BPS,
    { enforceResaleFloor: false });
  expect(summary.quote.feeAmount).toBe("0"); // Kept input is not swapped or charged.
  expect(current.chain.simulations).toHaveLength(1);
  expect(Buffer.from(transaction.serialize()).toString("base64")).toMatchSnapshot();
  const step = await createRaydiumClmmAdapter().prepareAdd(raydiumClmmFixtures.positionKey, OWNER, raydiumClmmFixtures.addInput, { step: 1, priorSignatures: [] });
  expect(step).toEqual({ step: 1, of: 1, label: "Add to the position", done: true, prepared: {
    kind: "solana-tx", transaction: Buffer.from(transaction.serialize()).toString("base64"), lastValidBlockHeight: summary.lastValidBlockHeight, positionMint: POSITION_MINT,
  } });
  expect(current.chain.simulations).toHaveLength(2);
});

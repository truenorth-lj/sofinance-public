import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_ADD_TOLERANCE_BPS, DEFAULT_RESALE_FLOOR_BPS, USDC_MINT } from "@sofinance/engine/ids";
import { buildAndSimulateSelectedZap } from "@/lib/selected-atomic";
import { createRaydiumAddChain, FEE_WALLET, OWNER, POSITION_MINT } from "./raydium-clmm.fixtures";
import { createRaydiumClmmAdapter } from "./adapter.server";
import { raydiumClmmFixtures } from "./raydium-clmm.fixtures";
import { APP_ADD_PREPARE, MCP_ADD_PREPARE, prepareAdd, simulateAdd } from "../index";
import { verifySelectedPermit } from "@/lib/selected-permit";
import { verifyTxLandedPermit, verifyTxSendPermit } from "@/lib/tx-send/permit";
import { VersionedTransaction } from "@solana/web3.js";
import * as build from "./build-add.server";

vi.mock("server-only", () => ({}));
const current = vi.hoisted(() => ({ chain: undefined as unknown as ReturnType<typeof createRaydiumAddChain> }));
vi.mock("@sofinance/engine/rpc", async (original) => ({
  ...await original<typeof import("@sofinance/engine/rpc")>(), rpcConnection: () => current.chain.connection,
}));
beforeEach(() => {
  current.chain = createRaydiumAddChain();
  vi.stubEnv("SOFINANCE_FEE_WALLET", FEE_WALLET); vi.stubEnv("SOFINANCE_FEE_BPS", "10");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
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

it("routes app, MCP, preflight and raw adds through the same complete build and binds recovery facts", async () => {
  const spy = vi.spyOn(build, "buildRaydiumAdd");
  const command = { wallet: OWNER, selection: { positionMint: POSITION_MINT, inputMint: USDC_MINT, inputKind: "token" as const },
    amount: "1", floorBps: DEFAULT_RESALE_FLOOR_BPS, toleranceBps: DEFAULT_ADD_TOLERANCE_BPS };
  const secret = "test-only-add-permit-key";
  const signal = new AbortController().signal;
  const app = await prepareAdd("raydium-clmm", command, () => secret, APP_ADD_PREPARE,
    { signal, budget: { deadlineAt: Date.now() + 8000, retriesLeft: 1 } });
  const mcp = await prepareAdd("raydium-clmm", command, () => secret, MCP_ADD_PREPARE);
  const preview = await simulateAdd("raydium-clmm", command, { enforceResaleFloor: false });
  const raw = await createRaydiumClmmAdapter().prepareAdd(raydiumClmmFixtures.positionKey, OWNER, raydiumClmmFixtures.addInput, { step: 1, priorSignatures: [] });
  expect(spy).toHaveBeenCalledTimes(4);
  expect(app.unsignedTransaction).toBe(mcp.unsignedTransaction);
  expect(app.unsignedTransaction).toBe(Buffer.from(preview.transaction.serialize()).toString("base64"));
  expect(raw.prepared).toMatchObject({ transaction: app.unsignedTransaction });
  for (const prepared of [app, mcp]) {
    const tx = VersionedTransaction.deserialize(Buffer.from(prepared.unsignedTransaction, "base64"));
    expect(prepared.submitArgs).toMatchObject({ wallet: OWNER, selection: command.selection, requested: "1000000",
      expectedLiquidity: prepared.summary.quote.liquidity, startingLiquidity: prepared.summary.startingLiquidity,
      lastValidBlockHeight: prepared.summary.lastValidBlockHeight, expiresAt: prepared.summary.expiresAt, permit: prepared.permit });
    const facts = { ...prepared.submitArgs, message: Buffer.from(tx.message.serialize()).toString("base64") };
    expect(verifySelectedPermit(secret, facts, prepared.permit)).toBe(true);
    expect(verifySelectedPermit(secret, { ...facts, requested: "1000001" }, prepared.permit)).toBe(false);
  }
  const bytes = Buffer.from(app.unsignedTransaction, "base64");
  expect(verifyTxSendPermit(secret, OWNER, bytes, app.sendPermit)).toBe(true);
  expect(verifyTxLandedPermit(secret, OWNER, bytes, app.summary.lastValidBlockHeight, app.landedPermit)).toBe(true);
  expect(verifyTxLandedPermit(secret, OWNER, bytes, app.summary.lastValidBlockHeight + 1, app.landedPermit)).toBe(false);
  expect(mcp).not.toHaveProperty("sendPermit");
  expect(mcp).not.toHaveProperty("landedPermit");
});

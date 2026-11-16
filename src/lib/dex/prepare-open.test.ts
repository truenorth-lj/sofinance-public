import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from "vitest";
import { VersionedTransaction } from "@solana/web3.js";
import type { OpenRangeInput } from "@sofinance/engine/open-range";
import type { OpenPositionSelection } from "@sofinance/engine/open-state";
import type { OpenPositionSummary, OpenPositionQuote } from "@sofinance/engine/open-types";
import type { SolSwapStepSummary } from "@sofinance/engine/sol-swap-types";
import { OPEN_FEE_ESTIMATE_MESSAGE } from "@sofinance/engine/rpc/fee-estimate";
import { buildTransaction, testKeypair, SIGNING_SECRET } from "@/lib/test-support/send-fixtures";
import { verifyOpenPositionPermit } from "@/lib/open-permit";
import { verifySolSwapPermit } from "@/lib/sol-swap-permit";
import { verifyTxSendPermit, verifyTxLandedPermit } from "@/lib/tx-send/permit";
import { prepareOpen, quoteOpen } from "./prepare-open.server";
import { prepareSolSwapStep, readSolSwapStepStatus } from "./prepare-sol-swap.server";
import { APP_OPEN_PREPARE, MCP_OPEN_PREPARE, APP_OPEN_QUOTE, type OpenPrepareCommand } from "./open-prepare";
import { createDexRegistry } from "./registry";
import { fakeSolanaModule } from "./__contract__/testing/fake-dex";
vi.mock("server-only", () => ({}));
const backend = vi.hoisted(() => ({ open: vi.fn(), quote: vi.fn(), swap: vi.fn(), delivery: vi.fn(), secret: vi.fn() }));
vi.mock("./registry-instance", () => ({ dexRegistry: { buildOpen: backend.open, quoteOpen: backend.quote,
  buildSolSwapStep: backend.swap, readSolSwapDelivery: backend.delivery } }));
vi.mock("@sofinance/engine/config/server-env", async original => ({
  ...await original<typeof import("@sofinance/engine/config/server-env")>(), getSigningSecret: backend.secret,
}));
const owner = testKeypair(1), nft = testKeypair(2), wallet = owner.publicKey.toBase58();
const transaction = buildTransaction({ payer: owner, extraSigners: [nft], signWith: [] });
const summary = { operation: "open-position", wallet, nftMint: nft.publicKey.toBase58(), lastValidBlockHeight: 150,
  quote: { requested: "9007199254740993" } } as OpenPositionSummary;
const swapSummary = { operation: "sol-swap-step", wallet, lastValidBlockHeight: 150 } as SolSwapStepSummary;
const request = (): OpenPrepareCommand => ({ wallet, selection: { poolId: testKeypair(3).publicKey.toBase58(),
  inputMint: testKeypair(4).publicKey.toBase58(), inputKind: "token" }, amount: "1", range: { preset: "custom", minPrice: "1", maxPrice: "2" },
  floorBps: 9900, toleranceBps: 200, nftMint: nft.publicKey.toBase58() });
const message = Buffer.from(transaction.message.serialize()).toString("base64");
beforeEach(() => { vi.resetAllMocks(); backend.open.mockResolvedValue({ summary, transaction });
  backend.quote.mockResolvedValue(summary.quote); backend.swap.mockResolvedValue({ summary: swapSummary, transaction });
  backend.secret.mockReturnValue(SIGNING_SECRET); });
afterEach(() => vi.unstubAllEnvs());

it("keeps open selection and extracted range contracts identical to the engine's public types", () => {
  expectTypeOf<OpenPrepareCommand["selection"]>().toEqualTypeOf<OpenPositionSelection>();
  expectTypeOf<OpenPrepareCommand["range"]>().toEqualTypeOf<OpenRangeInput>();
});
it.each([APP_OPEN_PREPARE, MCP_OPEN_PREPARE] as const)("keeps wallet and mint signatures empty and authorizes exact bytes for %s", async profile => {
  const secret = vi.fn(() => SIGNING_SECRET);
  const result = await prepareOpen("raydium-clmm", request(), secret, profile);
  const tx = VersionedTransaction.deserialize(Buffer.from(result.unsignedTransaction, "base64"));
  expect(tx.message.header.numRequiredSignatures).toBe(2);
  expect(tx.message.staticAccountKeys.slice(0, 2).map(k => k.toBase58())).toEqual([wallet, nft.publicKey.toBase58()]);
  expect(tx.signatures.every(signature => signature.every(byte => byte === 0))).toBe(true);
  expect(verifyOpenPositionPermit(SIGNING_SECRET, { wallet, message, summary }, result.permit)).toBe(true);
  expect(secret).toHaveBeenCalledOnce();
  if (profile === APP_OPEN_PREPARE) {
    expect(backend.open).toHaveBeenCalledWith("raydium-clmm", request(), { enforceResaleFloor: false });
    expect(verifyTxSendPermit(SIGNING_SECRET, wallet, Buffer.from(result.unsignedTransaction, "base64"), result.sendPermit)).toBe(true);
    expect(verifyTxLandedPermit(SIGNING_SECRET, wallet, Buffer.from(result.unsignedTransaction, "base64"), 150, result.landedPermit)).toBe(true);
  } else { expect(backend.open).toHaveBeenCalledWith("raydium-clmm", request()); expect(result).not.toHaveProperty("sendPermit"); }
});
it("snapshots wallet, pool, price bounds and mint before app retry can yield", async () => {
  let release!: () => void;
  backend.open.mockImplementationOnce(() => new Promise((_resolve, reject) => { release = () => reject(new Error(OPEN_FEE_ESTIMATE_MESSAGE)); }));
  const input = request(), expected = request();
  const pending = prepareOpen("raydium-clmm", input, () => SIGNING_SECRET, APP_OPEN_PREPARE);
  input.wallet = "changed"; input.selection.poolId = "changed"; input.nftMint = "changed";
  if (input.range.preset === "custom") input.range.maxPrice = "999";
  release(); await pending;
  expect(backend.open).toHaveBeenNthCalledWith(2, "raydium-clmm", expected, { enforceResaleFloor: false });
});
it("does not retry MCP failures or read a key before a successful build", async () => {
  backend.open.mockRejectedValue(new Error(OPEN_FEE_ESTIMATE_MESSAGE));
  const secret = vi.fn(() => SIGNING_SECRET);
  await expect(prepareOpen("raydium-clmm", request(), secret, MCP_OPEN_PREPARE)).rejects.toThrow(OPEN_FEE_ESTIMATE_MESSAGE);
  expect(backend.open).toHaveBeenCalledOnce(); expect(secret).not.toHaveBeenCalled();
});
it("keeps native SOL on the two-step flow and quote free of signing-key requirements", async () => {
  vi.stubEnv("VERCEL_ENV", "preview");
  const input = request(); input.selection.inputKind = "native";
  await expect(prepareOpen("raydium-clmm", input, () => SIGNING_SECRET, APP_OPEN_PREPARE)).rejects.toThrow("two steps");
  expect(backend.open).not.toHaveBeenCalled();
  expect(await quoteOpen("raydium-clmm", request(), APP_OPEN_QUOTE)).toBe(summary.quote);
  expect(backend.secret).not.toHaveBeenCalled();
});
it("binds the SOL swap to its own permit domain and returned relay bytes", async () => {
  vi.stubEnv("VERCEL_ENV", "preview");
  const result = await prepareSolSwapStep("raydium-clmm", wallet, "pool", "1");
  expect(backend.swap).toHaveBeenCalledWith("raydium-clmm", { wallet, poolId: "pool", amount: "1" });
  expect(verifySolSwapPermit(SIGNING_SECRET, { wallet, summary: swapSummary, message }, result.permit)).toBe(true);
  expect(verifyOpenPositionPermit(SIGNING_SECRET, { wallet, summary: swapSummary, message }, result.permit)).toBe(false);
  expect(verifyTxSendPermit(SIGNING_SECRET, wallet, Buffer.from(result.unsignedTransaction, "base64"), result.sendPermit)).toBe(true);
});
it("returns exact chain delivery including values above safe-integer range", async () => {
  const delivery = { status: "confirmed", delivered: "9007199254740993", decimals: 6, slot: 1, blockTime: null };
  backend.delivery.mockResolvedValue(delivery);
  expect(await readSolSwapStepStatus("raydium-clmm", wallet, "signature", "output", 150)).toBe(delivery);
  expect(backend.delivery).toHaveBeenCalledWith("raydium-clmm", { wallet, signature: "signature", outputMint: "output", lastValidBlockHeight: 150 });
});
it("requires explicit native bindings and clones terms before lazy loading even with generic capabilities off", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let received: unknown;
  const dexModule = { ...fakeSolanaModule, enabled: () => false, descriptor: { ...fakeSolanaModule.descriptor, capabilities: {
    ...fakeSolanaModule.descriptor.capabilities, open: { supported: false as const, reason: "Generic open unavailable" },
  } }, buildOpen: async (command: OpenPrepareCommand) => { await gate; received = command; return { summary, transaction }; },
    quoteOpen: async () => summary.quote as OpenPositionQuote,
    buildSolSwapStep: async () => ({ summary: swapSummary, transaction }), readSolSwapDelivery: async () => ({ status: "pending" as const }),
  };
  const registry = createDexRegistry([dexModule]);
  const command = request(), expected = request();
  const pending = registry.buildOpen(dexModule.descriptor.id, command);
  command.selection.poolId = "changed"; command.range = { preset: "tight" };
  release(); await pending; expect(received).toEqual(expected);
  expect(registry.isDisabled(dexModule.descriptor.id, "open")).toBe(true);
  await expect(registry.quoteOpen(dexModule.descriptor.id, request(), APP_OPEN_QUOTE)).resolves.toBe(summary.quote);
  await expect(registry.buildSolSwapStep(dexModule.descriptor.id, { wallet, poolId: "pool", amount: "1" })).resolves.toMatchObject({ summary: swapSummary });
  await expect(registry.readSolSwapDelivery(dexModule.descriptor.id, { wallet, signature: "sig", outputMint: "mint" })).resolves.toEqual({ status: "pending" });
  const absent = createDexRegistry([fakeSolanaModule]);
  for (const id of [dexModule.descriptor.id, "unknown"]) {
    await expect(absent.buildOpen(id, request())).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(absent.quoteOpen(id, request(), APP_OPEN_QUOTE)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(absent.buildSolSwapStep(id, { wallet, poolId: "pool", amount: "1" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(absent.readSolSwapDelivery(id, { wallet, signature: "sig", outputMint: "mint" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
  }
});

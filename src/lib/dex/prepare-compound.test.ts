import { beforeEach, expect, it, vi } from "vitest";
import type { CompoundSummary } from "@sofinance/engine/compound-types";
import type { CompoundRecoverySummary } from "@sofinance/engine/compound-recovery-types";
import { buildTransaction, testKeypair, SIGNING_SECRET } from "@/lib/test-support/send-fixtures";
import { verifyCompoundPermit } from "@/lib/compound-permit";
import { verifyTxSendPermit, verifyTxLandedPermit } from "@/lib/tx-send/permit";
import { prepareCompound, simulateCompound, prepareCompoundRecovery } from "./prepare-compound.server";
import { APP_COMPOUND_PREPARE, MCP_COMPOUND_PREPARE } from "./compound-prepare";
import { createDexRegistry } from "./registry";
import { fakeSolanaModule } from "./__contract__/testing/fake-dex";

vi.mock("server-only", () => ({}));
const backend = vi.hoisted(() => ({ compound: vi.fn(), recovery: vi.fn() }));
vi.mock("./registry-instance", () => ({ dexRegistry: { buildCompound: backend.compound, buildCompoundRecovery: backend.recovery } }));
const wallet = testKeypair(1).publicKey.toBase58();
const transaction = buildTransaction({ payer: testKeypair(1), signWith: [] });
const summary = { operation: "compound", state: { wallet }, lastValidBlockHeight: 150,
  priorSources: [{ sourceSignature: "original-source", amount: "9007199254740993" }] } as unknown as CompoundSummary;
const recoverySummary = { operation: "recovery", wallet, lastValidBlockHeight: 150,
  compoundAccounts: [{ address: "isolated-source", amount: "9007199254740993" }] } as unknown as CompoundRecoverySummary;
const request = () => ({ wallet, positionMint: testKeypair(2).publicKey.toBase58(), sourceSignatures: ["original-source"] });
const recovery = () => ({ wallet, compoundAccounts: [{ address: "isolated-source", seed: "original-seed" }] });
const message = Buffer.from(transaction.message.serialize()).toString("base64");
beforeEach(() => { vi.resetAllMocks(); backend.compound.mockResolvedValue({ summary, transaction });
  backend.recovery.mockResolvedValue({ summary: recoverySummary, transaction }); });

it.each([APP_COMPOUND_PREPARE, MCP_COMPOUND_PREPARE] as const)("keeps %s authorization bound to the complete summary and exact bytes", async profile => {
  const secret = vi.fn(() => SIGNING_SECRET);
  const result = await prepareCompound("raydium-clmm", request(), secret, profile);
  const bytes = Buffer.from(result.unsignedTransaction, "base64");
  expect(verifyCompoundPermit(SIGNING_SECRET, { wallet, summary, message }, result.permit)).toBe(true);
  expect(verifyCompoundPermit(SIGNING_SECRET, { wallet, summary: { ...summary, priorSources: [] }, message }, result.permit)).toBe(false);
  expect(secret).toHaveBeenCalledOnce();
  if (profile === APP_COMPOUND_PREPARE) {
    expect(verifyTxSendPermit(SIGNING_SECRET, wallet, bytes, result.sendPermit)).toBe(true);
    expect(verifyTxLandedPermit(SIGNING_SECRET, wallet, bytes, 150, result.landedPermit)).toBe(true);
  } else { expect(result).not.toHaveProperty("sendPermit"); expect(result).not.toHaveProperty("landedPermit"); }
});

it("retries fee-estimate failures only for app, preserving source signatures across the retry", async () => {
  let release!: () => void;
  backend.compound.mockImplementationOnce(() => new Promise((_resolve, reject) => {
    release = () => reject(new Error("Unable to estimate compound network fee"));
  }));
  const input = request();
  const pending = prepareCompound("raydium-clmm", input, () => SIGNING_SECRET, APP_COMPOUND_PREPARE);
  input.wallet = "changed"; input.sourceSignatures[0] = "replacement";
  release();
  const result = await pending;
  expect(backend.compound).toHaveBeenNthCalledWith(2, "raydium-clmm", request());
  expect(verifyCompoundPermit(SIGNING_SECRET, { wallet, summary, message }, result.permit)).toBe(true);
});

it.each([APP_COMPOUND_PREPARE, MCP_COMPOUND_PREPARE] as const)("never reads a key or retries a business failure for %s", async profile => {
  backend.compound.mockRejectedValue(new Error("Position is not eligible"));
  const secret = vi.fn(() => SIGNING_SECRET);
  await expect(prepareCompound("raydium-clmm", request(), secret, profile)).rejects.toThrow("not eligible");
  expect(backend.compound).toHaveBeenCalledOnce(); expect(secret).not.toHaveBeenCalled();
});

it("does not apply the app retry policy to MCP fee-estimate failures", async () => {
  backend.compound.mockRejectedValue(new Error("Unable to estimate compound network fee"));
  await expect(prepareCompound("raydium-clmm", request(), () => SIGNING_SECRET, MCP_COMPOUND_PREPARE)).rejects.toThrow("network fee");
  expect(backend.compound).toHaveBeenCalledOnce();
});

it("simulates quote without requiring a signing key", async () => {
  expect(await simulateCompound("raydium-clmm", request())).toEqual({ summary, transaction });
  expect(backend.compound).toHaveBeenCalledWith("raydium-clmm", request());
});

it("issues full-summary recovery permits with a separate operation and exact relay bytes", async () => {
  const result = await prepareCompoundRecovery("raydium-clmm", recovery(), () => SIGNING_SECRET);
  if ("alreadyClosed" in result) throw new Error("Expected an authorization");
  expect(verifyCompoundPermit(SIGNING_SECRET, { wallet, summary: recoverySummary, message }, result.permit)).toBe(true);
  expect(verifyCompoundPermit(SIGNING_SECRET, { wallet, summary: { ...recoverySummary, operation: "compound" }, message }, result.permit)).toBe(false);
  expect(verifyTxSendPermit(SIGNING_SECRET, wallet, Buffer.from(result.unsignedTransaction, "base64"), result.sendPermit)).toBe(true);
});

it("returns verified already-closed recovery without reading a signing key", async () => {
  const closed = { alreadyClosed: true, wallet, accounts: ["isolated-source"] };
  backend.recovery.mockResolvedValue(closed);
  const secret = vi.fn(() => SIGNING_SECRET);
  expect(await prepareCompoundRecovery("raydium-clmm", recovery(), secret)).toBe(closed);
  expect(secret).not.toHaveBeenCalled();
});

it("rejects failed recovery without authorizing it", async () => {
  backend.recovery.mockRejectedValue(new Error("Harvest account derived address mismatch or duplicate"));
  const secret = vi.fn(() => SIGNING_SECRET);
  await expect(prepareCompoundRecovery("raydium-clmm", recovery(), secret)).rejects.toThrow("derived address");
  expect(backend.recovery).toHaveBeenCalledOnce(); expect(secret).not.toHaveBeenCalled();
});

it("requires native bindings, snapshots nested input before lazy load and keeps generic capabilities off", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let compoundInput: unknown, recoveryInput: unknown;
  const dexModule = { ...fakeSolanaModule, descriptor: { ...fakeSolanaModule.descriptor, capabilities: {
    ...fakeSolanaModule.descriptor.capabilities, compound: { supported: false as const, reason: "Generic contract unavailable" },
  } }, enabled: () => false,
    buildCompound: async (input: ReturnType<typeof request>) => { await gate; compoundInput = input; return { summary, transaction }; },
    buildCompoundRecovery: async (input: { wallet: string; compoundAccounts: unknown }) => { await gate; recoveryInput = input; return { summary: recoverySummary, transaction }; },
  };
  const registry = createDexRegistry([dexModule]);
  const c = request(), r = recovery();
  const pending = [registry.buildCompound(dexModule.descriptor.id, c), registry.buildCompoundRecovery(dexModule.descriptor.id, r)];
  c.sourceSignatures[0] = "replacement"; r.compoundAccounts[0]!.seed = "replacement";
  release(); await Promise.all(pending);
  expect(compoundInput).toEqual(request()); expect(recoveryInput).toEqual(recovery());
  expect(registry.isDisabled(dexModule.descriptor.id, "compound")).toBe(true);
  await expect(registry.buildCompound("unknown", request())).rejects.toMatchObject({ code: "UNSUPPORTED" });
  await expect(registry.buildCompoundRecovery("unknown", recovery())).rejects.toMatchObject({ code: "UNSUPPORTED" });
  const absent = createDexRegistry([fakeSolanaModule]);
  await expect(absent.buildCompound(dexModule.descriptor.id, request())).rejects.toMatchObject({ code: "UNSUPPORTED" });
  await expect(absent.buildCompoundRecovery(dexModule.descriptor.id, recovery())).rejects.toMatchObject({ code: "UNSUPPORTED" });
});

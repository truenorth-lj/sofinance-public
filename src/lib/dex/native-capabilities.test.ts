import { expect, it, vi } from "vitest";
import { createDexRegistry } from "./registry";
import { dexDescriptors } from "./client";
import { fakeSolanaModule } from "./__contract__/testing/fake-dex";
import { raydiumPositionSource } from "@/lib/unified-positions/sources/raydium";
import { APP_OPEN_QUOTE, type OpenPrepareCommand } from "./open-prepare";
import type { AddPrepareCommand } from "./add-prepare";
import { DEX_MODULES } from "./modules";

const add: AddPrepareCommand = { wallet: "owner", selection: { positionMint: "nft", inputMint: "token", inputKind: "token" }, amount: "1", floorBps: 9900 };
const open: OpenPrepareCommand = { wallet: "owner", selection: { poolId: "pool", inputMint: "token", inputKind: "token" },
  amount: "1", range: { preset: "standard" }, floorBps: 9900, nftMint: "nft" };
const withdraw = { wallet: "owner", positionMint: "nft", percent: 50 };
const compound = { wallet: "owner", positionMint: "nft", sourceSignatures: [] };
const swap = { wallet: "owner", poolId: "pool", amount: "1" };
const delivery = { wallet: "owner", signature: "receipt", outputMint: "token" };
const no = { supported: false as const, reason: "Unavailable" };

it("shares the exact native position policy with the existing UI while generic contracts stay closed", () => {
  const descriptor = dexDescriptors.descriptorFor("raydium-clmm")!;
  expect(raydiumPositionSource.capabilities).toBe(descriptor.nativeCapabilities!.positions);
  expect(raydiumPositionSource.id).toBe(descriptor.id);
  expect(raydiumPositionSource.displayName).toBe(descriptor.displayName);
  expect(raydiumPositionSource.chain).toBe(descriptor.chain);
  expect(Object.keys(raydiumPositionSource.capabilities)).toEqual([
    "compound", "performance", "deposit", "withdraw", "withdrawOutputs", "exitPreview", "rangeDisplay", "manualAdd", "signer",
  ]);
  expect(descriptor.nativeCapabilities!.open.supported).toBe(true);
  expect(descriptor.nativeCapabilities!.positions.withdraw).toEqual({ supported: true, partial: true });
  expect(descriptor.nativeCapabilities!.positions.withdrawOutputs).toEqual(["pool-tokens", "usdc", "sol"]);
  expect([descriptor.capabilities.open, descriptor.capabilities.withdraw, descriptor.capabilities.compound].every(c => !c.supported)).toBe(true);
  const registry = createDexRegistry(DEX_MODULES);
  for (const op of ["open", "add", "withdraw", "compound", "positions", "performance"]) expect(registry.isDisabled(descriptor.id, op)).toBe(true);
});

function bindings() {
  return { buildAdd: vi.fn().mockResolvedValue({}), buildWithdrawal: vi.fn().mockResolvedValue({}), buildCompound: vi.fn().mockResolvedValue({}),
    buildOpen: vi.fn().mockResolvedValue({}), quoteOpen: vi.fn().mockResolvedValue({}), buildSolSwapStep: vi.fn().mockResolvedValue({}),
    buildCompoundRecovery: vi.fn().mockResolvedValue({ alreadyClosed: true, wallet: "owner", accounts: ["source"] }),
    readSolSwapDelivery: vi.fn().mockResolvedValue({ status: "confirmed", delivered: "9007199254740993", decimals: 6, slot: 1, blockTime: null }) };
}
const attempts = (registry: ReturnType<typeof createDexRegistry>, id: string) => [
  () => registry.buildAdd(id, add), () => registry.buildWithdrawal(id, withdraw), () => registry.buildCompound(id, compound),
  () => registry.buildOpen(id, open), () => registry.quoteOpen(id, open, APP_OPEN_QUOTE), () => registry.buildSolSwapStep(id, swap),
];

it("native policy refuses new preparation before any lazy binding even when generic capabilities support it", async () => {
  const ports = bindings();
  const descriptor = { ...fakeSolanaModule.descriptor, nativeCapabilities: { open: no,
    positions: { ...fakeSolanaModule.descriptor.capabilities, deposit: no, withdraw: no, compound: no } } };
  const registry = createDexRegistry([{ ...fakeSolanaModule, descriptor, ...ports }]);
  for (const invoke of attempts(registry, descriptor.id)) await expect(invoke()).rejects.toMatchObject({ code: "UNSUPPORTED" });
  for (const name of ["buildAdd", "buildWithdrawal", "buildCompound", "buildOpen", "quoteOpen", "buildSolSwapStep"] as const) expect(ports[name]).not.toHaveBeenCalled();
  // Recovery and receipt reconciliation remain available when new operations stop.
  await expect(registry.buildCompoundRecovery(descriptor.id, { wallet: "owner", compoundAccounts: [] })).resolves.toHaveProperty("alreadyClosed", true);
  await expect(registry.readSolSwapDelivery(descriptor.id, delivery)).resolves.toHaveProperty("delivered", "9007199254740993");
});

it("native preparation follows its declared policy independently of generic rollout capabilities", async () => {
  const ports = bindings();
  const original = fakeSolanaModule.descriptor;
  const descriptor = { ...original, capabilities: { ...original.capabilities, open: no, deposit: no, withdraw: no, compound: no },
    nativeCapabilities: { open: original.capabilities.open, positions: original.capabilities } };
  const registry = createDexRegistry([{ ...fakeSolanaModule, descriptor, enabled: () => false, ...ports }]);
  for (const invoke of attempts(registry, descriptor.id)) await expect(invoke()).resolves.toEqual({});
  for (const name of ["buildAdd", "buildWithdrawal", "buildCompound", "buildOpen", "quoteOpen", "buildSolSwapStep"] as const) expect(ports[name]).toHaveBeenCalledOnce();
  expect(registry.isDisabled(descriptor.id, "open")).toBe(true);
});

it("keeps existing modules without native metadata on their generic capability policy", async () => {
  const ports = bindings(), descriptor = fakeSolanaModule.descriptor;
  const registry = createDexRegistry([{ ...fakeSolanaModule, ...ports }]);
  for (const invoke of attempts(registry, descriptor.id)) await expect(invoke()).resolves.toEqual({});
  const disabled = createDexRegistry([{ ...fakeSolanaModule, ...ports,
    descriptor: { ...descriptor, capabilities: { ...descriptor.capabilities, open: no, deposit: no, withdraw: no, compound: no } } }]);
  for (const invoke of attempts(disabled, descriptor.id)) await expect(invoke()).rejects.toMatchObject({ code: "UNSUPPORTED" });
});

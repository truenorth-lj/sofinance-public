import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Connection } from "@solana/web3.js";
import { dexRegistry, nativePositionPerformance, nativePositionRangeStatus } from "./index";
import { createDexRegistry } from "./registry";
import { fakeSolanaModule } from "./__contract__/testing/fake-dex";

vi.mock("server-only", () => ({}));
const backend = vi.hoisted(() => ({ rayPerformance: vi.fn(), rayRange: vi.fn(), orcaProbe: vi.fn(), orcaPerformance: vi.fn(),
  orcaRange: vi.fn(), meteoraProbe: vi.fn(), meteoraPerformance: vi.fn(), meteoraRange: vi.fn() }));
vi.mock("@/lib/position-performance", () => ({ getPositionPerformance: backend.rayPerformance }));
vi.mock("@/lib/position-range-onchain", () => ({ readPositionRangeFacts: backend.rayRange }));
vi.mock("@/lib/orca-positions", () => ({ positionMintLooksLikeOrca: backend.orcaProbe,
  getOrcaPositionPerformance: backend.orcaPerformance, readOrcaPositionRangeFacts: backend.orcaRange }));
vi.mock("@/lib/meteora-positions", () => ({ positionAccountLooksLikeMeteora: backend.meteoraProbe,
  getMeteoraPositionPerformance: backend.meteoraPerformance, readMeteoraPositionRangeFacts: backend.meteoraRange }));

const facts = { positionMint: "position", poolId: "pool", mintA: "A", mintB: "B", decimalsA: 6, decimalsB: 6,
  tickLower: -10, tickUpper: 10, tickCurrent: 0, onChainPriceBPerA: 1 };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("NEXT_PUBLIC_SOFI_DEPLOY_ENV", ""); vi.stubEnv("VERCEL_ENV", "preview");
  backend.orcaProbe.mockResolvedValue(false); backend.meteoraProbe.mockResolvedValue(false);
  backend.rayPerformance.mockResolvedValue({ wallet: "owner", positionMint: "position" }); backend.rayRange.mockResolvedValue(facts);
});
afterEach(() => { vi.unstubAllEnvs(); });

it("preserves the fixed App Raydium reader, option snapshot and live signal/connection references before lazy load", async () => {
  const signal = new AbortController().signal, connection = {} as Connection;
  const options = { wallet: "owner", maxSignatures: 50, skipPricing: true, refreshHistory: true,
    historyAfterSignatures: ["original"], signal, connection };
  const pending = dexRegistry.readPositionPerformance("raydium-clmm", "position", options);
  options.wallet = "other"; options.historyAfterSignatures[0] = "other";
  await pending;
  expect(backend.rayPerformance).toHaveBeenCalledExactlyOnceWith("position", {
    wallet: "owner", maxSignatures: 50, skipPricing: true, refreshHistory: true, historyAfterSignatures: ["original"], signal, connection,
  });
  expect(backend.rayPerformance.mock.calls[0]![1].signal).toBe(signal);
  expect(backend.rayPerformance.mock.calls[0]![1].connection).toBe(connection);
  expect(backend.orcaProbe).not.toHaveBeenCalled(); expect(backend.meteoraProbe).not.toHaveBeenCalled();
});

it("captures MCP identity and history terms before a delayed source probe", async () => {
  const gate = deferred<boolean>(), started = deferred<void>();
  backend.orcaProbe.mockImplementation(async () => { started.resolve(); return gate.promise; });
  const command = { positionMint: "position", wallet: "owner", maxSignatures: 50, skipPricing: true,
    refreshHistory: true, historyAfterSignatures: ["original"] };
  const pending = nativePositionPerformance(command);
  command.positionMint = "other"; command.wallet = "other"; command.maxSignatures = 500; command.historyAfterSignatures[0] = "other";
  await started.promise; gate.resolve(false); await pending;
  expect(backend.orcaProbe).toHaveBeenCalledExactlyOnceWith("position");
  expect(backend.meteoraProbe).toHaveBeenCalledExactlyOnceWith("position");
  expect(backend.rayPerformance).toHaveBeenCalledExactlyOnceWith("position", { wallet: "owner", maxSignatures: 50,
    skipPricing: true, refreshHistory: true, historyAfterSignatures: ["original"] });
});

it("captures range wallet, position and explicit pool before a delayed probe", async () => {
  const gate = deferred<boolean>(), started = deferred<void>();
  backend.orcaProbe.mockImplementation(async () => { started.resolve(); return gate.promise; });
  backend.orcaRange.mockResolvedValue(facts);
  const command = { positionMint: "position", wallet: "owner", poolId: "explicit-pool" };
  const pending = nativePositionRangeStatus(command);
  command.positionMint = "other"; command.wallet = "other"; command.poolId = "other";
  await started.promise; gate.resolve(true);
  expect(await pending).toMatchObject({ protocol: "orca-whirlpool", wallet: "owner", positionMint: "position", poolId: "explicit-pool" });
  expect(backend.orcaRange).toHaveBeenCalledExactlyOnceWith("position"); expect(backend.rayRange).not.toHaveBeenCalled();
});

it.each(["performance", "range"] as const)("rechecks native admission after a delayed probe before %s I/O", async kind => {
  const gate = deferred<boolean>(), started = deferred<void>();
  backend.orcaProbe.mockImplementation(async () => { started.resolve(); return gate.promise; });
  const pending = kind === "performance" ? nativePositionPerformance({ positionMint: "position" })
    : nativePositionRangeStatus({ positionMint: "position" });
  await started.promise; vi.stubEnv("VERCEL_ENV", "production"); gate.resolve(true);
  const result = await pending;
  expect(result).not.toHaveProperty("protocol", "orca-whirlpool");
  expect(backend.orcaPerformance).not.toHaveBeenCalled(); expect(backend.orcaRange).not.toHaveBeenCalled();
  expect(backend.meteoraProbe).not.toHaveBeenCalled();
  expect(kind === "performance" ? backend.rayPerformance : backend.rayRange).toHaveBeenCalledOnce();
});

it.each(["performance", "range"] as const)("keeps null-%s fallback distinct from a selected reader error", async kind => {
  backend.orcaProbe.mockResolvedValue(true);
  const selected = kind === "performance" ? backend.orcaPerformance : backend.orcaRange;
  const fallback = kind === "performance" ? backend.rayPerformance : backend.rayRange;
  const call = () => kind === "performance" ? nativePositionPerformance({ positionMint: "position" })
    : nativePositionRangeStatus({ positionMint: "position" });
  selected.mockResolvedValueOnce(null); await call(); expect(fallback).toHaveBeenCalledOnce();
  fallback.mockClear(); const error = new Error("selected reader RPC failure"); selected.mockRejectedValueOnce(error);
  await expect(call()).rejects.toBe(error); expect(fallback).not.toHaveBeenCalled(); expect(backend.meteoraProbe).not.toHaveBeenCalled();
});

it("keeps explicit source ordering, default-off admission and generic rollout separate", async () => {
  expect(dexRegistry.nativePositionReaders().map(reader => reader.source)).toEqual(["orca", "meteora", "raydium"]);
  vi.stubEnv("VERCEL_ENV", "production");
  for (const id of ["orca-whirlpool", "meteora-dlmm", "unknown"]) {
    await expect(dexRegistry.readPositionPerformance(id, "position", {})).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(dexRegistry.readPositionRange(id, "position")).rejects.toMatchObject({ code: "UNSUPPORTED" });
  }
  const absent = createDexRegistry([fakeSolanaModule]);
  await expect(absent.readPositionPerformance(fakeSolanaModule.descriptor.id, "position", {})).rejects.toMatchObject({ code: "UNSUPPORTED" });
  await expect(absent.readPositionRange(fakeSolanaModule.descriptor.id, "position")).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(backend.orcaPerformance).not.toHaveBeenCalled(); expect(backend.meteoraPerformance).not.toHaveBeenCalled();
  await expect(dexRegistry.readPositionPerformance("raydium-clmm", "position", {})).resolves.toMatchObject({ wallet: "owner" });
  expect(dexRegistry.isDisabled("raydium-clmm", "performance")).toBe(true);
});

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Connection } from "@solana/web3.js";
import { dexRegistry, listNativeWalletPositions } from "./index";
import { createDexRegistry } from "./registry";
import { fakeSolanaModule } from "./__contract__/testing/fake-dex";

vi.mock("server-only", () => ({}));
const backend = vi.hoisted(() => ({ discover: vi.fn(), orca: vi.fn(), meteora: vi.fn() }));
vi.mock("@sofinance/engine/wallet-discovery", () => ({ discoverWallet: backend.discover }));
vi.mock("@/lib/orca-positions", () => ({ listOrcaPositions: backend.orca }));
vi.mock("@/lib/meteora-positions", () => ({ listMeteoraPositions: backend.meteora }));

const row = { positionMint: "ray-position", positionAccount: "ray-account", poolId: "pool", mintA: "A", mintB: "B",
  tickLower: -10, tickUpper: 10, tickCurrent: 0, rangeSide: "inside", liquidity: "9007199254740993" };
const asset = { kind: "token", mint: "A", tokenProgram: "token-program", decimals: 6,
  balance: "9007199254740993", totalBalance: "9007199254740993", account: "asset-ata", eligible: true, reason: null };
const discovery = { wallet: "owner", slot: 42, fetchedAt: 12345, positions: [{ ...row, symbolA: "A", symbolB: "B" }], assets: [asset] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("NEXT_PUBLIC_SOFI_DEPLOY_ENV", ""); vi.stubEnv("VERCEL_ENV", "preview");
  backend.discover.mockResolvedValue(discovery); backend.orca.mockResolvedValue([]); backend.meteora.mockResolvedValue([]);
});
afterEach(() => { vi.unstubAllEnvs(); });

it("preserves the MCP default-RPC one-argument scan and App's exact read-connection reference", async () => {
  expect(await dexRegistry.discoverNativeWallet("raydium-clmm", "owner")).toBe(discovery);
  expect(backend.discover).toHaveBeenCalledExactlyOnceWith("owner");
  backend.discover.mockClear(); const connection = {} as Connection;
  expect(await dexRegistry.discoverNativeWallet("raydium-clmm", "owner", connection)).toBe(discovery);
  expect(backend.discover).toHaveBeenCalledExactlyOnceWith("owner", connection);
  expect(backend.discover.mock.calls[0]![1]).toBe(connection);
});

it("starts every admitted reader together and captures wallet identity while preserving row and field order", async () => {
  const ray = deferred<unknown>(), orca = deferred<unknown>(), meteora = deferred<unknown>();
  const rayStarted = deferred<void>(), orcaStarted = deferred<void>(), meteoraStarted = deferred<void>();
  backend.discover.mockImplementation(async () => { rayStarted.resolve(); return ray.promise; });
  backend.orca.mockImplementation(async () => { orcaStarted.resolve(); return orca.promise; });
  backend.meteora.mockImplementation(async () => { meteoraStarted.resolve(); return meteora.promise; });
  const command = { wallet: "owner" }, pending = listNativeWalletPositions(command);
  command.wallet = "other";
  // All starts must happen before any result is released: no sequential wallet scans.
  await Promise.all([rayStarted.promise, orcaStarted.promise, meteoraStarted.promise]);
  const orcaRow = { ...row, positionMint: "orca-position", protocol: "orca-whirlpool", extra: "retained" };
  const meteoraRow = { ...row, positionMint: "meteora-position", protocol: "meteora-dlmm", activeBinId: 0 };
  meteora.resolve([meteoraRow]); orca.resolve([orcaRow]); ray.resolve(discovery);
  const result = await pending;
  expect(result).toEqual({ wallet: "owner", slot: 42, fetchedAt: 12345, positions: [row, orcaRow, meteoraRow], assets: [asset] });
  expect(Object.keys(result)).toEqual(["wallet", "slot", "fetchedAt", "positions", "assets"]);
  expect(backend.discover).toHaveBeenCalledExactlyOnceWith("owner");
  expect(backend.orca).toHaveBeenCalledExactlyOnceWith("owner"); expect(backend.meteora).toHaveBeenCalledExactlyOnceWith("owner");
});

it("keeps optional failures ordered, sanitized and separate from required discovery", async () => {
  backend.orca.mockRejectedValueOnce(new Error("RPC failed https://rpc.invalid/?api-key=secret-orca-value"));
  backend.meteora.mockRejectedValueOnce(new Error("RPC failed https://rpc.invalid/?api-key=secret-meteora-value"));
  const result = await listNativeWalletPositions({ wallet: "owner" });
  expect(result.positions).toEqual([row]); expect(result.assets).toEqual([asset]);
  expect(result.protocolErrors?.map(error => error.protocol)).toEqual(["orca-whirlpool", "meteora-dlmm"]);
  expect(JSON.stringify(result)).not.toContain("secret-orca-value"); expect(JSON.stringify(result)).not.toContain("secret-meteora-value");
});

it("propagates mandatory Raydium discovery failure unchanged while consuming optional rejections", async () => {
  const error = new Error("Required wallet discovery failed");
  backend.discover.mockRejectedValueOnce(error); backend.orca.mockRejectedValueOnce(new Error("optional Orca failed"));
  backend.meteora.mockRejectedValueOnce(new Error("optional Meteora failed"));
  await expect(listNativeWalletPositions({ wallet: "owner" })).rejects.toBe(error);
});

it("does not call optional readers outside explicit preview/development targets", async () => {
  for (const target of ["production", "staging", "", undefined]) {
    vi.stubEnv("VERCEL_ENV", target);
    expect(await listNativeWalletPositions({ wallet: "owner" })).toEqual({ ...discovery, positions: [row] });
  }
  expect(backend.orca).not.toHaveBeenCalled(); expect(backend.meteora).not.toHaveBeenCalled();
  expect(dexRegistry.isDisabled("raydium-clmm", "positions")).toBe(true);
});

it("requires explicit discovery/list bindings and enforces the native list flag before I/O", async () => {
  const absent = createDexRegistry([fakeSolanaModule]);
  for (const id of [fakeSolanaModule.descriptor.id, "unknown"]) {
    await expect(absent.discoverNativeWallet(id, "owner")).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(absent.listNativePositionRows(id, "owner")).rejects.toMatchObject({ code: "UNSUPPORTED" });
  }
  vi.stubEnv("VERCEL_ENV", "production");
  for (const id of ["orca-whirlpool", "meteora-dlmm"]) {
    await expect(dexRegistry.listNativePositionRows(id, "owner")).rejects.toMatchObject({ code: "UNSUPPORTED" });
  }
  expect(backend.orca).not.toHaveBeenCalled(); expect(backend.meteora).not.toHaveBeenCalled();
});

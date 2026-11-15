import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ADD_TOLERANCE_BPS, DEFAULT_RESALE_FLOOR_BPS, USDC_MINT } from "@sofinance/engine/ids";
import { buildAndSimulateSelectedZap } from "@/lib/selected-atomic";
import type { PositionKey } from "@/lib/unified-positions/model";
import { createRaydiumClmmAdapter } from "./adapter.server";
import { ata, createRaydiumAddChain, FEE_WALLET, OWNER, POSITION_MINT, raydiumClmmFixtures, STRANGER, tokenAccount } from "./raydium-clmm.fixtures";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/sentry/capture", () => ({ captureDexMisconfiguration: vi.fn() }));
const current = vi.hoisted(() => ({ chain: undefined as unknown as ReturnType<typeof createRaydiumAddChain> }));
vi.mock("@sofinance/engine/rpc", async (original) => ({
  ...await original<typeof import("@sofinance/engine/rpc")>(), rpcConnection: () => current.chain.connection,
}));
const FIRST_STEP = { step: 1, priorSignatures: [] };
const { positionKey, addInput } = raydiumClmmFixtures;
const prepare = (owner = OWNER) => createRaydiumClmmAdapter().prepareAdd(positionKey, owner, addInput, FIRST_STEP);
beforeEach(() => {
  current.chain = createRaydiumAddChain();
  vi.stubEnv("SOFINANCE_FEE_WALLET", FEE_WALLET); vi.stubEnv("SOFINANCE_FEE_BPS", "10");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("Raydium add admission", () => {
  it.each(["0", "-1", "0.1", "1e6", "18446744073709551616", "1".repeat(41)])("refuses invalid raw amount %s before RPC", async amountRaw => {
    const read = vi.spyOn(current.chain.connection, "getMultipleAccountsInfoAndContext");
    await expect(createRaydiumClmmAdapter().prepareAdd(positionKey, OWNER, { ...addInput, amountRaw }, FIRST_STEP)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(read).not.toHaveBeenCalled();
  });
  it.each(["meteora-dlmm:fixture", "raydium-clmm:bad", "raydium-clmm:"])("refuses malformed position key %s", async key => {
    await expect(createRaydiumClmmAdapter().prepareAdd(key as PositionKey, OWNER, addInput, FIRST_STEP)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(current.chain.simulations).toHaveLength(0);
  });
  it("refuses a nonexistent second step", async () => {
    await expect(createRaydiumClmmAdapter().prepareAdd(positionKey, OWNER, addInput, { ...FIRST_STEP, step: 2 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
  it.each([true, false])("refuses a stranger before simulation (input ATA exists: %s)", async hasInput => {
    if (!hasInput) current.chain.accounts.delete(ata(USDC_MINT, STRANGER));
    await expect(prepare(STRANGER)).rejects.toMatchObject({ code: "POSITION_NOT_FOUND" });
    expect(current.chain.simulations).toHaveLength(0);
  });
  it("rechecks ownership after the precision read", async () => {
    const read = current.chain.connection.getMultipleAccountsInfoAndContext.bind(current.chain.connection);
    let reads = 0;
    vi.spyOn(current.chain.connection, "getMultipleAccountsInfoAndContext").mockImplementation((...args) => {
      if (++reads === 5) current.chain.accounts.delete(ata(POSITION_MINT));
      return read(...args);
    });
    await expect(prepare()).rejects.toMatchObject({ code: "POSITION_NOT_FOUND" });
    expect(current.chain.simulations).toHaveLength(0);
  });
  it.each(["empty", "insufficient", "missing ATA", "SOL reserve"])("classifies %s as insufficient funds before simulation", async mode => {
    if (mode === "missing ATA") current.chain.accounts.delete(ata(USDC_MINT));
    else if (mode === "SOL reserve") current.chain.accounts.get(OWNER)!.lamports = 1;
    else current.chain.accounts.set(ata(USDC_MINT), tokenAccount(USDC_MINT, OWNER, mode === "empty" ? 0n : 999_999n));
    await expect(prepare()).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
    expect(current.chain.simulations).toHaveLength(0);
  });
  it("classifies a frozen pool/input token as token restricted before simulation", async () => {
    current.chain.accounts.get(ata(USDC_MINT))!.data[108] = 2;
    await expect(prepare()).rejects.toMatchObject({ code: "TOKEN_RESTRICTED" });
    expect(current.chain.simulations).toHaveLength(0);
  });
  it("classifies an input frozen between the two state reads as token restricted", async () => {
    const read = current.chain.connection.getMultipleAccountsInfoAndContext.bind(current.chain.connection);
    let reads = 0;
    vi.spyOn(current.chain.connection, "getMultipleAccountsInfoAndContext").mockImplementation((...args) => {
      if (++reads === 5) current.chain.accounts.get(ata(USDC_MINT))!.data[108] = 2;
      return read(...args);
    });
    await expect(prepare()).rejects.toMatchObject({ code: "TOKEN_RESTRICTED" });
    expect(current.chain.simulations).toHaveLength(0);
  });
  it.each([undefined, "0", "11", "invalid"])("fails closed when fee config disagrees with the descriptor (%s)", async bps => {
    if (bps === undefined) vi.stubEnv("SOFINANCE_FEE_WALLET", undefined);
    else vi.stubEnv("SOFINANCE_FEE_BPS", bps);
    const read = vi.spyOn(current.chain.connection, "getMultipleAccountsInfoAndContext");
    await expect(prepare()).rejects.toMatchObject({ code: "MISCONFIGURED" });
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects fee settings that change while reading the position", async () => {
    const read = current.chain.connection.getMultipleAccountsInfoAndContext.bind(current.chain.connection);
    let reads = 0;
    vi.spyOn(current.chain.connection, "getMultipleAccountsInfoAndContext").mockImplementation((...args) => {
      if (++reads === 5) vi.stubEnv("SOFINANCE_FEE_BPS", "11");
      return read(...args);
    });
    await expect(prepare()).rejects.toMatchObject({ code: "MISCONFIGURED" });
  });
  it("preserves the browser Jupiter relay round-trip", async () => {
    const relay = new Error("Missing browser quote"); relay.name = "JupiterRelayMissingError";
    vi.spyOn(current.chain.connection, "getMultipleAccountsInfoAndContext").mockRejectedValue(relay);
    await expect(prepare()).rejects.toBe(relay);
  });
  it("normalizes RPC failures to a DexError and redacts endpoint credentials", async () => {
    vi.spyOn(current.chain.connection, "getMultipleAccountsInfoAndContext").mockRejectedValue(new Error("RPC failed https://rpc.example/private-key"));
    await expect(prepare()).rejects.toMatchObject({ name: "DexError", code: "UPSTREAM", message: expect.not.stringContaining("private-key") });
  });
  it("keeps the exact raw input above Number's safe-integer range", async () => {
    current.chain.accounts.set(ata(USDC_MINT), tokenAccount(USDC_MINT, OWNER, 10_000_000_000_000_000n));
    const result = await createRaydiumClmmAdapter().prepareAdd(positionKey, OWNER, { ...addInput, amountRaw: "9007199254740993" }, FIRST_STEP);
    const original = await buildAndSimulateSelectedZap(OWNER, { positionMint: POSITION_MINT, inputMint: USDC_MINT, inputKind: "token" },
      "9007199254.740993", DEFAULT_RESALE_FLOOR_BPS, DEFAULT_ADD_TOLERANCE_BPS, { enforceResaleFloor: false });
    expect(original.summary.quote.requested).toBe("9007199254740993");
    expect(result.prepared).toMatchObject({ kind: "solana-tx", transaction: Buffer.from(original.transaction.serialize()).toString("base64") });
    expect(current.chain.simulations).toHaveLength(2);
  });
});

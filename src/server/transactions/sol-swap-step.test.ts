import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/engine-host", () => ({}));

const engine = vi.hoisted(() => ({ delivery: vi.fn(), build: vi.fn(), feeSeen: [] as number[] }));
vi.mock("@sofinance/engine/sol-swap-step", () => ({ readSolSwapDelivery: engine.delivery, buildAndSimulateSolSwapStep: vi.fn() }));
vi.mock("@sofinance/engine/open-atomic", () => ({ buildAndSimulateOpenPosition: engine.build }));
vi.mock("@/lib/open-permit", () => ({ issueOpenPositionPermit: () => "permit" }));
vi.mock("@/lib/rpc-fee-estimate", () => ({ withFeeEstimateRetry: (fn: () => unknown) => fn() }));

import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { readSwapFeeConfig } from "@sofinance/engine/swap/fee";
import { assertSolSwapFeeCredit, SOL_SWAP_FEE_CREDIT_MS } from "./sol-swap-step";
import { prepareOpen, SINGLE_TX_SOL_OPEN_MESSAGE } from "./open-prepare";
import { APP_OPEN_PREPARE, MCP_OPEN_PREPARE } from "./surface-policy";

const wallet = Keypair.generate().publicKey.toBase58();
const mint = Keypair.generate().publicKey.toBase58();
const signature = bs58.encode(new Uint8Array(64).fill(7));
const now = 1_800_000_000_000;
const delivered = (over: Record<string, unknown> = {}) => ({
  status: "confirmed", delivered: "24650000", decimals: 9, blockTime: now / 1000 - 60, feeAccountPaid: true, ...over,
});

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  vi.stubEnv("SOFINANCE_FEE_WALLET", Keypair.generate().publicKey.toBase58());
  vi.stubEnv("SOFINANCE_FEE_BPS", "10");
  engine.delivery.mockReset().mockResolvedValue(delivered());
  engine.feeSeen = [];
  engine.build.mockReset().mockImplementation(async () => {
    engine.feeSeen.push(readSwapFeeConfig().bps);
    return { summary: { ok: true }, transaction: { message: { serialize: () => new Uint8Array([1]) }, serialize: () => new Uint8Array([2]) } };
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("assertSolSwapFeeCredit", () => {
  it("accepts a recent confirmed fee-paying swap that delivered at least the open amount", async () => {
    await expect(assertSolSwapFeeCredit(wallet, signature, mint, "0.02465")).resolves.toBeUndefined();
    expect(engine.delivery).toHaveBeenCalledWith({ signature, wallet, outputMint: mint });
  });
  it.each([
    ["unconfirmed", { status: "pending" }, "not confirmed"],
    ["fee not paid", { feeAccountPaid: false }, "did not pay the protocol fee"],
    ["too old", { blockTime: (now - SOL_SWAP_FEE_CREDIT_MS - 1000) / 1000 }, "too old"],
    ["over-claimed", { delivered: "24649999" }, "exceeds what the step 1/2 swap delivered"],
  ])("rejects %s", async (_name, over, message) => {
    engine.delivery.mockResolvedValue(delivered(over));
    await expect(assertSolSwapFeeCredit(wallet, signature, mint, "0.02465")).rejects.toThrow(message);
  });
  it("rejects a malformed signature without touching RPC", async () => {
    await expect(assertSolSwapFeeCredit(wallet, "abc", mint, "1")).rejects.toThrow("Invalid step-1 swap signature");
    expect(engine.delivery).not.toHaveBeenCalled();
  });
});

describe("prepareOpen with SOL", () => {
  const command = (over: Record<string, unknown> = {}) => ({
    wallet, poolId: "pool", selection: { inputMint: mint, inputKind: "token" as const }, amount: "0.02465",
    range: { preset: "standard" }, floorBps: 0, nftMint: "nft", ...over,
  }) as unknown as Parameters<typeof prepareOpen>[0];

  it("refuses single-transaction native SOL opens for the app and MCP", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const native = command({ selection: { inputMint: "So11111111111111111111111111111111111111112", inputKind: "native" } });
    for (const profile of [APP_OPEN_PREPARE, MCP_OPEN_PREPARE] as const) {
      await expect(prepareOpen(native, () => "secret", profile)).rejects.toThrow(SINGLE_TX_SOL_OPEN_MESSAGE);
    }
    expect(engine.build).not.toHaveBeenCalled();
  });
  it("charges the normal token fee without a step-1 signature", async () => {
    await prepareOpen(command(), () => "secret", APP_OPEN_PREPARE);
    expect(engine.feeSeen).toEqual([10]);
    expect(engine.delivery).not.toHaveBeenCalled();
  });
  it("waives the fee for step 2/2 only after the step-1 swap is verified", async () => {
    await prepareOpen(command({ solSwapSignature: signature }), () => "secret", APP_OPEN_PREPARE);
    expect(engine.feeSeen).toEqual([0]);
    expect(readSwapFeeConfig().bps).toBe(10);
  });
  it("does not build when the step-1 swap check fails", async () => {
    engine.delivery.mockResolvedValue(delivered({ feeAccountPaid: false }));
    await expect(prepareOpen(command({ solSwapSignature: signature }), () => "secret", APP_OPEN_PREPARE)).rejects.toThrow("protocol fee");
    expect(engine.build).not.toHaveBeenCalled();
  });
  it("ignores a step-1 signature on the MCP surface (fee still charged)", async () => {
    await prepareOpen(command({ solSwapSignature: signature }), () => "secret", MCP_OPEN_PREPARE);
    expect(engine.feeSeen).toEqual([10]);
  });
});

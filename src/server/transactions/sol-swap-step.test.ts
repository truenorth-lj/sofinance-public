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
import { prepareOpen, SINGLE_TX_SOL_OPEN_MESSAGE } from "./open-prepare";
import { APP_OPEN_PREPARE, MCP_OPEN_PREPARE } from "./surface-policy";

const wallet = Keypair.generate().publicKey.toBase58();
const mint = Keypair.generate().publicKey.toBase58();
const signature = bs58.encode(new Uint8Array(64).fill(7));

beforeEach(() => {
  vi.stubEnv("SOFINANCE_FEE_WALLET", Keypair.generate().publicKey.toBase58());
  vi.stubEnv("SOFINANCE_FEE_BPS", "10");
  engine.delivery.mockReset();
  engine.feeSeen = [];
  engine.build.mockReset().mockImplementation(async () => {
    engine.feeSeen.push(readSwapFeeConfig().bps);
    return { summary: { ok: true }, transaction: { message: { serialize: () => new Uint8Array([1]) }, serialize: () => new Uint8Array([2]) } };
  });
});
afterEach(() => { vi.unstubAllEnvs(); });

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
    expect(engine.build.mock.calls[0]?.[6]).not.toHaveProperty("minContextSlot");
  });
  it("charges the normal token fee even when a valid step-1 signature is passed", async () => {
    // The app client still sends solSwapSignature when resuming step 2/2. The
    // param is ignored: it does not waive the fee or change the build options.
    await prepareOpen(command({ solSwapSignature: signature }), () => "secret", APP_OPEN_PREPARE);
    expect(engine.feeSeen).toEqual([10]);
    expect(readSwapFeeConfig().bps).toBe(10);
    expect(engine.delivery).not.toHaveBeenCalled();
    expect(engine.build.mock.calls[0]?.[6]).not.toHaveProperty("minContextSlot");
  });
  it("also charges the fee on the MCP surface when a step-1 signature is passed", async () => {
    await prepareOpen(command({ solSwapSignature: signature }), () => "secret", MCP_OPEN_PREPARE);
    expect(engine.feeSeen).toEqual([10]);
    expect(engine.delivery).not.toHaveBeenCalled();
  });
});

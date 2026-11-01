import { VersionedTransaction } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { USDC_MINT, NATIVE_SOL_MINT } from "@sofinance/engine/ids";
import { meteoraSpotSplit } from "@sofinance/engine/protocols/meteora/open";
import { setFetchReplay } from "@/lib/test-support/offline-fetch";
import type { OpenRequest } from "../adapter";
import { describeDexContract } from "../__contract__/dex-contract";
import { DexError } from "../errors";
import { createMeteoraDlmmAdapter } from "./adapter.server";
import { clearMeteoraPoolListCache } from "./pools.server";
import {
  capture, createFakeChain, DEPOSIT_RAW, FEE_WALLET, jupiterReplay, OWNER, POSITION, SPCX_POOL, TSLA, TSLA_POOL, TSLAX,
  ata, positionAccount, type FakeChain,
} from "./meteora-dlmm.fixtures";
import { meteoraDlmmModule } from "./module";

/**
 * Meteora DLMM against the shared DEX contract, offline: the RPC is a fake chain built from the recorded mainnet
 * capture of the RWA pools (meteora-dlmm-rwa-t22.json), Jupiter is a recorded-shape replay, and the pool list comes
 * from a stubbed RWA feed. fetch itself is blocked by the vitest setup file before any module loads.
 */
const chain = vi.hoisted(() => ({ current: undefined as unknown as FakeChain }));

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sofinance/engine/rpc")>()),
  rpcConnection: () => chain.current.connection,
}));
vi.mock("@/lib/rwa-store", () => ({
  getRwaStore: () => ({
    request: async () => [{ pair: { poolAddress: TSLA_POOL, protocol: "meteora-dlmm", mintA: TSLA, mintB: TSLAX, blocked: false } }],
  }),
}));

function installChain(autoLand = true) {
  chain.current = createFakeChain({ autoLand });
  clearMeteoraPoolListCache();
  vi.stubEnv("SOFINANCE_RWA_DB_ENABLED", "true");
  vi.stubEnv("SOFINANCE_FEE_WALLET", FEE_WALLET);
  vi.stubEnv("SOFINANCE_FEE_BPS", "10");
  vi.stubEnv("JUPITER_API_KEY", "fixture-key");
  return () => vi.unstubAllEnvs();
}

const base = { poolId: TSLA_POOL, owner: OWNER, input: { token: TSLA, amountRaw: DEPOSIT_RAW }, slippageBps: 50, cosigner: POSITION } as const;
const request: OpenRequest = { ...base, range: { kind: "preset", presetId: "standard" } };

// Standard preset on 8k2c: bins 46031..46090 (60 bins, arrays 657–658, both recorded as existing; active bin 46062).
// Spot split: TSLA (X) funds the bins from the active bin up and is kept; the TSLAx (Y) side is swapped and charged.
const ySpend = meteoraSpotSplit(BigInt(DEPOSIT_RAW), 46062, 46031, 46090).y;

describeDexContract(meteoraDlmmModule, {
  owner: OWNER,
  setup: () => installChain(),
  fetch: jupiterReplay,
  expectedPositionKeys: [],
  open: { request, expectedSteps: 2, expectedFeeBaseRaw: ySpend.toString() },
  blockedOpens: [
    { ...base, range: { kind: "preset", presetId: "wide" } }, // 200 bins > 70: not available to open yet
    { ...base, range: { kind: "units", lower: 45980, upper: 46000 } }, // needs bin array 656, which does not exist
    { ...base, input: { token: NATIVE_SOL_MINT, amountRaw: "1000000" }, range: request.range }, // SOL input
    { ...base, poolId: SPCX_POOL, input: { token: TSLA, amountRaw: DEPOSIT_RAW }, range: request.range }, // not in the feed
  ],
  feeWallet: FEE_WALLET,
  mintPrograms: { [TSLA]: "token-2022", [TSLAX]: "token-2022", [USDC_MINT]: "spl-token" },
});

describe("Meteora DLMM adapter specifics", () => {
  let teardown: () => void;
  beforeEach(() => {
    const restoreEnv = installChain(false);
    const restoreFetch = setFetchReplay(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const replay = jupiterReplay(url, init);
      if (!replay) throw new Error(`no fixture replay for ${new URL(url).host}`);
      return replay;
    });
    teardown = () => { restoreFetch(); restoreEnv(); };
  });
  afterEach(() => teardown());

  it("discloses the refundable 0.0419 SOL position rent for a 60-bin position", async () => {
    const quote = await createMeteoraDlmmAdapter().quoteOpen(request);
    expect(quote.blockedReason).toBeUndefined();
    expect(quote.rent).toEqual({ refundableLamports: "41899840", nonRefundableLamports: "0" });
    expect(quote.range.units).toBe(60);
  });

  it("blocks the wide preset with RANGE_UNSUPPORTED and a missing bin array with NEEDS_NEW_SHARED_ACCOUNT", async () => {
    const adapter = createMeteoraDlmmAdapter();
    const wide = adapter.prepareOpen({ ...base, range: { kind: "preset", presetId: "wide" } }, { step: 1, priorSignatures: [] });
    await expect(wide).rejects.toMatchObject({ code: "RANGE_UNSUPPORTED", message: expect.stringContaining("not available to open yet") });
    const far = adapter.prepareOpen({ ...base, range: { kind: "units", lower: 45980, upper: 46000 } }, { step: 1, priorSignatures: [] });
    await expect(far).rejects.toMatchObject({ code: "NEEDS_NEW_SHARED_ACCOUNT" });
  });

  it("refuses when the bitmap extension the range needs is missing", async () => {
    chain.current.set(capture.pools[TSLA_POOL]!.bitmapExtension.address, null);
    const quote = await createMeteoraDlmmAdapter().quoteOpen(request);
    expect(quote.blockedReason).toMatch(/bitmap extension/);
  });

  it("returns TOKEN_RESTRICTED when a pool mint trips the Token-2022 guard", async () => {
    chain.current.pauseMint(TSLA);
    const adapter = createMeteoraDlmmAdapter();
    expect((await adapter.quoteOpen(request)).blockedReason).toMatch(/transfers paused/);
    const prepared = adapter.prepareOpen(request, { step: 1, priorSignatures: [] });
    await expect(prepared).rejects.toBeInstanceOf(DexError);
    await expect(prepared).rejects.toMatchObject({ code: "TOKEN_RESTRICTED" });
  });

  it("walks setup → deposit only once step 1 has landed, then recovery closes an emptied position", async () => {
    const adapter = createMeteoraDlmmAdapter();
    const step1 = await adapter.prepareOpen(request, { step: 1, priorSignatures: [] });
    expect(step1).toMatchObject({ step: 1, of: 2, done: false, planToken: POSITION, prepared: { kind: "solana-tx", cosignRef: POSITION } });
    // Not landed yet: step 2 must refuse rather than build against a missing position.
    await expect(adapter.prepareOpen(request, { step: 2, priorSignatures: ["sig"], planToken: POSITION })).rejects.toMatchObject({ code: "POSITION_NOT_FOUND" });
    if (step1.prepared.kind !== "solana-tx") throw new Error("expected a Solana step");
    chain.current.land(VersionedTransaction.deserialize(Buffer.from(step1.prepared.transaction, "base64")));
    const step2 = await adapter.prepareOpen(request, { step: 2, priorSignatures: ["sig"], planToken: POSITION });
    expect(step2).toMatchObject({ step: 2, of: 2, done: true });
    if (step2.prepared.kind !== "solana-tx") throw new Error("expected a Solana step");
    // The 10 bps is paid only inside the Jupiter swap, into the fee wallet's existing TSLA account (never created here).
    const deposit = VersionedTransaction.deserialize(Buffer.from(step2.prepared.transaction, "base64"));
    const keys = deposit.message.staticAccountKeys.map((key) => key.toBase58());
    expect(keys).toContain("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
    expect(keys).toContain(ata(TSLA, FEE_WALLET));
    expect(keys).not.toContain(FEE_WALLET);

    const recovery = await adapter.prepareRecovery!(`meteora-dlmm:${POSITION}`, { step: 1, priorSignatures: [] });
    expect(recovery).toMatchObject({ step: 1, of: 1, done: true });
    expect(chain.current.simulations.at(-1)).toBe("close_position2");
  });

  it("does not close a position that holds liquidity", async () => {
    chain.current.set(POSITION, positionAccount(TSLA_POOL, OWNER, 46031, 60, 5n));
    await expect(createMeteoraDlmmAdapter().prepareRecovery!(`meteora-dlmm:${POSITION}`, { step: 1, priorSignatures: [] }))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("accepts only USDC and the pool's own tokens, at the fixed 0.5% slippage", async () => {
    const adapter = createMeteoraDlmmAdapter();
    const sol = await adapter.quoteOpen({ ...request, input: { token: NATIVE_SOL_MINT, amountRaw: "1" } });
    expect(sol.blockedReason).toMatch(/SOL/);
    await expect(adapter.quoteOpen({ ...request, slippageBps: 100 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});

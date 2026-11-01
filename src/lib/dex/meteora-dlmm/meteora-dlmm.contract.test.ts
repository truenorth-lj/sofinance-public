import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { USDC_MINT, NATIVE_SOL_MINT } from "@sofinance/engine/ids";
import { meteoraSpotSplit } from "@sofinance/engine/protocols/meteora/open";
import { setFetchReplay } from "@/lib/test-support/offline-fetch";
import type { OpenRequest } from "../adapter";
import { describeDexContract } from "../__contract__/dex-contract";
import { DexError } from "../errors";
import { FEE_WALLET_MISSING_MESSAGE } from "../fee-wallet.server";
import { NO_FEE_POLICY } from "../fees";
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
const sentry = vi.hoisted(() => ({ misconfigured: [] as unknown[][] }));

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sofinance/engine/rpc")>()),
  rpcConnection: () => chain.current.connection,
}));
vi.mock("@/lib/sentry/capture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sentry/capture")>()),
  captureDexMisconfiguration: (...args: unknown[]) => { sentry.misconfigured.push(args); },
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

/** An existing position of OWNER in the feed-listed 8k2c pool (listed through the RWA feed, not the static allowlist). */
const FEED_POSITION = Keypair.fromSeed(new Uint8Array(32).fill(21)).publicKey.toBase58();
/** OWNER's position in 5pw5, which the stubbed feed does not list: never shown. */
const UNLISTED_POSITION = Keypair.fromSeed(new Uint8Array(32).fill(22)).publicKey.toBase58();
/** Liquidity share held in FEED_POSITION's first bin (so partial withdraw and claim have something to act on). */
const FEED_SHARE = 1_000_000n;
const STRANGER = Keypair.fromSeed(new Uint8Array(32).fill(23)).publicKey.toBase58();
const STRANGER_POSITION = Keypair.fromSeed(new Uint8Array(32).fill(24)).publicKey.toBase58();

function installHeldPositions() {
  chain.current.set(FEED_POSITION, positionAccount(TSLA_POOL, OWNER, 46031, 60, FEED_SHARE));
  chain.current.set(UNLISTED_POSITION, positionAccount(SPCX_POOL, OWNER, 46031, 60, 5n));
  chain.current.set(STRANGER_POSITION, positionAccount(TSLA_POOL, STRANGER, 46031, 60, 5n));
}

describeDexContract(meteoraDlmmModule, {
  owner: OWNER,
  setup: () => { const restore = installChain(); installHeldPositions(); return restore; },
  fetch: jupiterReplay,
  expectedPositionKeys: [`meteora-dlmm:${FEED_POSITION}`],
  open: { request, expectedSteps: 2, expectedFeeBaseRaw: ySpend.toString() },
  positionKey: `meteora-dlmm:${FEED_POSITION}`,
  stranger: STRANGER,
  addInput: { token: TSLA, amountRaw: DEPOSIT_RAW },
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

  it("lists the owner's positions in feed pools only, and only the static allowlist when the RWA store is off", async () => {
    installHeldPositions();
    const listed = await createMeteoraDlmmAdapter().listPositions(OWNER);
    expect(listed.map((position) => position.key)).toEqual([`meteora-dlmm:${FEED_POSITION}`]);
    expect(listed[0]).toMatchObject({ source: "meteora-dlmm", chain: "solana", poolId: TSLA_POOL, tokenA: { id: TSLA }, tokenB: { id: TSLAX } });
    // The shared panel's Liquidity / Unclaimed fees rows read these (raw atomic strings from the position's bins).
    expect(listed[0]!.holdings).toEqual({ liquidityRaw: { a: expect.stringMatching(/^\d+$/), b: expect.stringMatching(/^\d+$/) },
      unclaimedFeesRaw: { a: expect.stringMatching(/^\d+$/), b: expect.stringMatching(/^\d+$/) } });
    vi.stubEnv("SOFINANCE_RWA_DB_ENABLED", "false");
    clearMeteoraPoolListCache();
    expect(await createMeteoraDlmmAdapter().listPositions(OWNER)).toEqual([]);
  });

  it("fails the whole list (never a partial one) when the feed cannot be read", async () => {
    installHeldPositions();
    const listedPool = async () => { throw new Error("feed read failed at https://db.example/secret"); };
    await expect(createMeteoraDlmmAdapter({ listedPool }).listPositions(OWNER)).rejects.toBeInstanceOf(DexError);
  });

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

    const recovery = await adapter.prepareRecovery!(`meteora-dlmm:${POSITION}`, OWNER, { step: 1, priorSignatures: [] });
    expect(recovery).toMatchObject({ step: 1, of: 1, done: true });
    expect(chain.current.simulations.at(-1)).toBe("close_position2");
    if (recovery.prepared.kind !== "solana-tx") throw new Error("expected a Solana step");
    // Paid and signed by the owner, and the rent receiver of close_position2 is the owner.
    const close = VersionedTransaction.deserialize(Buffer.from(recovery.prepared.transaction, "base64"));
    const accounts = close.message.staticAccountKeys.map((key) => key.toBase58());
    expect(accounts[0]).toBe(OWNER);
    expect(close.message.header.numRequiredSignatures).toBe(1);
    const closeIx = close.message.compiledInstructions.at(-1)!;
    expect(closeIx.accountKeyIndexes.map((index) => accounts[index])).toEqual(expect.arrayContaining([POSITION, OWNER]));
    expect(accounts[closeIx.accountKeyIndexes[1]!]).toBe(OWNER); // sender
    expect(accounts[closeIx.accountKeyIndexes[2]!]).toBe(OWNER); // rent receiver
  });

  it("closes only the requesting wallet's own position", async () => {
    chain.current.set(POSITION, positionAccount(TSLA_POOL, OWNER, 46031, 60));
    const stranger = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey.toBase58();
    await expect(createMeteoraDlmmAdapter().prepareRecovery!(`meteora-dlmm:${POSITION}`, stranger, { step: 1, priorSignatures: [] }))
      .rejects.toMatchObject({ code: "POSITION_NOT_FOUND", message: expect.stringMatching(/another wallet/) });
    expect(chain.current.simulations).not.toContain("close_position2");
  });

  it("refuses to open without a fee wallet in every environment (no VERCEL_ENV involved), builds nothing, and reports it", async () => {
    vi.stubEnv("SOFINANCE_FEE_WALLET", ""); // NODE_ENV=test, no VERCEL_ENV: still refused
    sentry.misconfigured.length = 0;
    const adapter = createMeteoraDlmmAdapter();
    await expect(adapter.quoteOpen(request)).rejects.toMatchObject({ code: "MISCONFIGURED", message: FEE_WALLET_MISSING_MESSAGE });
    await expect(adapter.prepareOpen(request, { step: 1, priorSignatures: [] })).rejects.toMatchObject({ code: "MISCONFIGURED" });
    expect(chain.current.simulations).toEqual([]);
    expect(sentry.misconfigured).toEqual([["meteora-dlmm", "open", "fee_wallet_missing"], ["meteora-dlmm", "open", "fee_wallet_missing"]]);
  });

  it("charges nothing only with an explicit \"none\" fee policy", async () => {
    vi.stubEnv("SOFINANCE_FEE_WALLET", "");
    sentry.misconfigured.length = 0;
    const quote = await createMeteoraDlmmAdapter({ feePolicy: NO_FEE_POLICY }).quoteOpen(request);
    expect(quote.platformFeeRaw).toBe("0");
    expect(quote.blockedReason).toBeUndefined();
    expect(sentry.misconfigured).toEqual([]);
  });

  it("does not close a position that holds liquidity", async () => {
    chain.current.set(POSITION, positionAccount(TSLA_POOL, OWNER, 46031, 60, 5n));
    await expect(createMeteoraDlmmAdapter().prepareRecovery!(`meteora-dlmm:${POSITION}`, OWNER, { step: 1, priorSignatures: [] }))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("accepts only USDC and the pool's own tokens, at the fixed 0.5% slippage", async () => {
    const adapter = createMeteoraDlmmAdapter();
    const sol = await adapter.quoteOpen({ ...request, input: { token: NATIVE_SOL_MINT, amountRaw: "1" } });
    expect(sol.blockedReason).toMatch(/SOL/);
    await expect(adapter.quoteOpen({ ...request, slippageBps: 100 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  describe("add / withdraw / claim (PR6)", () => {
    const key = `meteora-dlmm:${FEED_POSITION}` as const;
    const first = { step: 1, priorSignatures: [] };
    const decoded = (prepared: { kind: string; transaction?: string }) => {
      if (prepared.kind !== "solana-tx" || !prepared.transaction) throw new Error("expected a Solana step");
      const tx = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, "base64"));
      return { tx, keys: tx.message.staticAccountKeys.map((k) => k.toBase58()) };
    };
    beforeEach(() => installHeldPositions());

    it("refuses every op for a wallet that does not own the position (decoded on-chain owner), building nothing", async () => {
      const adapter = createMeteoraDlmmAdapter();
      for (const run of [
        () => adapter.prepareAdd(key, STRANGER, { token: TSLA, amountRaw: DEPOSIT_RAW }, first),
        () => adapter.prepareWithdraw(key, STRANGER, { fraction: 1, output: "pool-tokens" }, first),
        () => adapter.prepareWithdraw(key, STRANGER, { fraction: 0.5, output: "pool-tokens" }, first),
        () => adapter.prepareClaim(key, STRANGER, first),
      ]) await expect(run()).rejects.toMatchObject({ code: "POSITION_NOT_FOUND", message: expect.stringMatching(/another wallet/) });
      // The stranger's own position cannot be driven by OWNER either.
      await expect(adapter.prepareClaim(`meteora-dlmm:${STRANGER_POSITION}`, OWNER, first)).rejects.toMatchObject({ code: "POSITION_NOT_FOUND" });
      expect(chain.current.simulations).toEqual([]);
    });

    it("partial withdraw removes the share only (fees stay), paid by the owner, no fee", async () => {
      const step = await createMeteoraDlmmAdapter().prepareWithdraw(key, OWNER, { fraction: 0.25, output: "pool-tokens" }, first);
      expect(step).toMatchObject({ step: 1, of: 1, done: true, label: expect.stringMatching(/Withdraw 25% of the position/) });
      expect(chain.current.simulations).toEqual(["remove_liquidity_by_range2"]);
      const { tx, keys } = decoded(step.prepared);
      expect(keys[0]).toBe(OWNER);
      expect(tx.message.header.numRequiredSignatures).toBe(1);
      expect(keys).not.toContain(FEE_WALLET);
      expect(keys).not.toContain(ata(TSLA, FEE_WALLET));
      expect(keys).not.toContain("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
    });

    it("full withdraw removes everything, claims fees and closes the position with the rent back to the owner (and says so)", async () => {
      const rent = chain.current.get(FEED_POSITION)!.lamports;
      const step = await createMeteoraDlmmAdapter().prepareWithdraw(key, OWNER, { fraction: 1, output: "pool-tokens" }, first);
      expect(chain.current.simulations).toEqual(["remove_liquidity_by_range2", "claim_fee2", "close_position2"]);
      expect(step.label).toContain(`rent (about ${(rent / 1e9).toFixed(4)} SOL) comes back to your wallet`);
      const { tx, keys } = decoded(step.prepared);
      const close = tx.message.compiledInstructions.at(-1)!;
      expect(keys[close.accountKeyIndexes[2]!]).toBe(OWNER); // rent receiver
      expect(keys).not.toContain(FEE_WALLET);
    });

    it("full withdraw of an emptied position skips the remove and still claims and closes", async () => {
      chain.current.set(FEED_POSITION, positionAccount(TSLA_POOL, OWNER, 46031, 60));
      await createMeteoraDlmmAdapter().prepareWithdraw(key, OWNER, { fraction: 1, output: "pool-tokens" }, first);
      expect(chain.current.simulations).toEqual(["claim_fee2", "close_position2"]);
      await expect(createMeteoraDlmmAdapter().prepareWithdraw(key, OWNER, { fraction: 0.5, output: "pool-tokens" }, first))
        .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    });

    it("refuses withdraw to USDC and an out-of-range share", async () => {
      const adapter = createMeteoraDlmmAdapter();
      await expect(adapter.prepareWithdraw(key, OWNER, { fraction: 1, output: "usdc" }, first)).rejects.toMatchObject({ code: "UNSUPPORTED" });
      await expect(adapter.prepareWithdraw(key, OWNER, { fraction: 0, output: "pool-tokens" }, first)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(adapter.prepareWithdraw(key, OWNER, { fraction: 1.5, output: "pool-tokens" }, first)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(chain.current.simulations).toEqual([]);
    });

    it("claims fees without touching liquidity, and charges no fee", async () => {
      const step = await createMeteoraDlmmAdapter().prepareClaim(key, OWNER, first);
      expect(chain.current.simulations).toEqual(["claim_fee2"]);
      const { keys } = decoded(step.prepared);
      expect(keys[0]).toBe(OWNER);
      expect(keys).not.toContain(FEE_WALLET);
    });

    it("adds to the position with the 10 bps paid inside the Jupiter swap into the fee wallet's existing account", async () => {
      const step = await createMeteoraDlmmAdapter().prepareAdd(key, OWNER, { token: TSLA, amountRaw: DEPOSIT_RAW }, first);
      expect(step).toMatchObject({ step: 1, of: 1, done: true });
      expect(chain.current.simulations).toContain("add_liquidity_by_strategy2");
      const { keys } = decoded(step.prepared);
      expect(keys[0]).toBe(OWNER);
      expect(keys).toContain("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
      expect(keys).toContain(ata(TSLA, FEE_WALLET));
      expect(keys).not.toContain(FEE_WALLET);
    });

    it("runs the Token-2022 mint guard on add, withdraw and claim", async () => {
      chain.current.pauseMint(TSLA);
      const adapter = createMeteoraDlmmAdapter();
      await expect(adapter.prepareAdd(key, OWNER, { token: TSLA, amountRaw: DEPOSIT_RAW }, first)).rejects.toMatchObject({ code: "TOKEN_RESTRICTED" });
      await expect(adapter.prepareWithdraw(key, OWNER, { fraction: 1, output: "pool-tokens" }, first)).rejects.toMatchObject({ code: "TOKEN_RESTRICTED" });
      await expect(adapter.prepareClaim(key, OWNER, first)).rejects.toMatchObject({ code: "TOKEN_RESTRICTED" });
      expect(chain.current.simulations).toEqual([]);
    });

    it("never creates a bin array: a missing one refuses withdraw, claim and add", async () => {
      const [index, array] = Object.entries(capture.pools[TSLA_POOL]!.binArrays).find(([i, a]) => a.exists && Number(i) === 657)!;
      expect(index).toBe("657");
      chain.current.set(array.address, null);
      const adapter = createMeteoraDlmmAdapter();
      await expect(adapter.prepareWithdraw(key, OWNER, { fraction: 1, output: "pool-tokens" }, first)).rejects.toMatchObject({ code: "UPSTREAM", message: expect.stringMatching(/bin array/) });
      await expect(adapter.prepareClaim(key, OWNER, first)).rejects.toMatchObject({ code: "UPSTREAM" });
      await expect(adapter.prepareAdd(key, OWNER, { token: TSLA, amountRaw: DEPOSIT_RAW }, first)).rejects.toMatchObject({ code: "NEEDS_NEW_SHARED_ACCOUNT" });
      expect(chain.current.simulations).toEqual([]);
    });

    it("lets withdraw and claim reach a position in a pool the feed no longer lists (funds never trapped); add refuses", async () => {
      const unlisted = `meteora-dlmm:${UNLISTED_POSITION}` as const;
      const adapter = createMeteoraDlmmAdapter();
      await expect(adapter.prepareWithdraw(unlisted, OWNER, { fraction: 1, output: "pool-tokens" }, first)).resolves.toMatchObject({ done: true });
      await expect(adapter.prepareAdd(unlisted, OWNER, { token: TSLA, amountRaw: DEPOSIT_RAW }, first)).rejects.toBeInstanceOf(DexError);
    });
  });
});

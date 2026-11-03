import { AccountLayout, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { USDC_MINT, NATIVE_SOL_MINT } from "@sofinance/engine/ids";
import { meteoraSpotSplit } from "@sofinance/engine/protocols/meteora/open";
import { setFetchReplay } from "@/lib/test-support/offline-fetch";
import { METEORA_REWARD_INFOS_OFFSET } from "@sofinance/engine/protocols/meteora/accounts";
import type { OpenRequest } from "../adapter";
import { describeDexContract } from "../__contract__/dex-contract";
import { DexError } from "../errors";
import { FEE_WALLET_MISSING_MESSAGE } from "../fee-wallet.server";
import { NO_FEE_POLICY } from "../fees";
import { openRentLines } from "@/components/unified-positions/registry-tools";
import { createMeteoraDlmmAdapter } from "./adapter.server";
import { clearMeteoraPoolListCache } from "./pools.server";
import {
  capture, createFakeChain, DEPOSIT_RAW, FEE_WALLET, jupiterReplay, OWNER, POSITION, rentFor, RWA_TOKEN_ACCOUNT_SPACE, SPCX_POOL, tokenAccount, TSLA, TSLA_POOL, TSLAX,
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

const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
/**
 * The instructions of a prepared Solana step with their program and account addresses. Every account must resolve from
 * the static keys (the fixtures use no lookup tables), so an instruction account can never hide behind an index.
 */
function compiledInstructions(prepared: { kind: string; transaction?: string }) {
  if (prepared.kind !== "solana-tx" || !prepared.transaction) throw new Error("expected a Solana step");
  const message = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, "base64")).message;
  const keys = message.staticAccountKeys.map((k) => k.toBase58());
  const at = (index: number) => {
    const key = keys[index];
    if (!key) throw new Error(`instruction account ${index} is not a static key (lookup tables are not expected here)`);
    return key;
  };
  return message.compiledInstructions.map((ix) => ({ program: at(ix.programIdIndex), accounts: ix.accountKeyIndexes.map(at) }));
}

/** An existing position of OWNER in the feed-listed 8k2c pool (listed through the RWA feed, not the static allowlist). */
const FEED_POSITION = Keypair.fromSeed(new Uint8Array(32).fill(21)).publicKey.toBase58();
/** OWNER's position in 5pw5, which the stubbed feed does not list: never shown. */
const UNLISTED_POSITION = Keypair.fromSeed(new Uint8Array(32).fill(22)).publicKey.toBase58();
/** Liquidity share held in FEED_POSITION's first bin (so partial withdraw and claim have something to act on). */
const FEED_SHARE = 1_000_000n;
/** FEED_POSITION's unclaimed swap fees (raw TSLA / TSLAx) that claim_fee2 pays out in the fake chain. */
const FEED_FEES = { x: 1_500n, y: 2_500n };
const STRANGER = Keypair.fromSeed(new Uint8Array(32).fill(23)).publicKey.toBase58();
const STRANGER_POSITION = Keypair.fromSeed(new Uint8Array(32).fill(24)).publicKey.toBase58();

function installHeldPositions() {
  chain.current.set(FEED_POSITION, positionAccount(TSLA_POOL, OWNER, 46031, 60, FEED_SHARE));
  chain.current.set(UNLISTED_POSITION, positionAccount(SPCX_POOL, OWNER, 46031, 60, 5n));
  chain.current.set(STRANGER_POSITION, positionAccount(TSLA_POOL, STRANGER, 46031, 60, 5n));
  chain.current.setClaimable(FEED_POSITION, FEED_FEES.x, FEED_FEES.y);
  chain.current.setClaimable(UNLISTED_POSITION, 7n, 9n);
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
    // The rent a full withdraw pays back, stated before signing: the position account's own lamports (60-bin position:
    // 0.0419 SOL, as disclosed at open).
    expect(listed[0]!.closeRefundLamports).toBe("41899840");
    vi.stubEnv("SOFINANCE_RWA_DB_ENABLED", "false");
    clearMeteoraPoolListCache();
    expect(await createMeteoraDlmmAdapter().listPositions(OWNER)).toEqual([]);
  });

  it("reads performance for a feed-listed position (the Performance tab's report), and refuses an unlisted pool", async () => {
    installHeldPositions();
    const adapter = createMeteoraDlmmAdapter();
    const key = `meteora-dlmm:${FEED_POSITION}` as const;
    const performance = await adapter.performance(key);
    // The recorded chain has no history for this position (no deposit records) and its bins hold no recorded
    // reserves: every amount is 0 and PnL, which needs deposits, stays null. Prices and names come from Jupiter. No open
    // was found in that history, so the summary is marked partial even though the read was not truncated.
    expect(performance).toMatchObject({ key, depositedUsd: 0, withdrawnUsd: 0, feesClaimedUsd: 0, feesUnclaimedUsd: 0, currentValueUsd: 0, pnlUsd: null, partial: true });
    // Only the fields the Performance tab draws: no raw history, fetch metrics or timings.
    for (const field of ["history", "historyFetch", "timings", "wallet", "maxSignatures", "positionAccount"]) expect(performance.report).not.toHaveProperty(field);
    expect(performance.report?.cashflows).toEqual({ openCount: 0, increaseCount: 0, decreaseCount: 0 });
    expect(performance.report).toMatchObject({
      positionMint: FEED_POSITION, poolId: TSLA_POOL, mintA: TSLA, mintB: TSLAX, truncated: false,
      pricing: { priceUsdA: 400.10567118198486, priceUsdB: 399.6496888563945 },
      tokenNative: { symbolA: "TSLA", symbolB: "TSLAx" },
    });
    await expect(adapter.performance(`meteora-dlmm:${UNLISTED_POSITION}`)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(adapter.performance(`meteora-dlmm:${STRANGER}`)).rejects.toMatchObject({ code: "POSITION_NOT_FOUND" });
  });

  it("fails the whole list (never a partial one) when the feed cannot be read", async () => {
    installHeldPositions();
    const listedPool = async () => { throw new Error("feed read failed at https://db.example/secret"); };
    await expect(createMeteoraDlmmAdapter({ listedPool }).listPositions(OWNER)).rejects.toBeInstanceOf(DexError);
  });

  it("discloses the refundable 0.0419 SOL position rent for a 60-bin position", async () => {
    const quote = await createMeteoraDlmmAdapter().quoteOpen(request);
    expect(quote.blockedReason).toBeUndefined();
    // OWNER already holds TSLA; the TSLAx account is new: 179 bytes on chain (Token-2022 extensions), not 165.
    expect(quote.rent).toEqual({ refundableLamports: "41899840", nonRefundableLamports: "0", tokenAccountLamports: String(rentFor(RWA_TOKEN_ACCOUNT_SPACE)) });
    expect(quote.range.units).toBe(60);
  });

  describe("Token-2022 token-account rent: the quote and the setup SOL cap agree (PR9.2)", () => {
    const POSITION_RENT = 41_899_840n;
    const T22_RENT = BigInt(rentFor(RWA_TOKEN_ACCOUNT_SPACE));
    /** OWNER's USDC (SPL) account holding the deposit: with USDC as the input, neither pool-token account is needed up front. */
    function holdUsdc() {
      const data = Buffer.alloc(AccountLayout.span);
      AccountLayout.encode({
        mint: new PublicKey(USDC_MINT), owner: new PublicKey(OWNER), amount: BigInt(DEPOSIT_RAW), delegateOption: 0, delegate: PublicKey.default, state: 1,
        isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default,
      }, data);
      const usdcAta = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), new PublicKey(OWNER), true, TOKEN_PROGRAM_ID).toBase58();
      chain.current.set(usdcAta, { owner: TOKEN_PROGRAM_ID, data, lamports: rentFor(AccountLayout.span), executable: false, rentEpoch: 0 });
    }
    const cases = [
      { name: "neither pool-token account exists", missing: [TSLA, TSLAX], setup: () => { holdUsdc(); chain.current.set(ata(TSLA, OWNER), null); }, input: USDC_MINT },
      { name: "one side is missing (TSLAx)", missing: [TSLAX], setup: () => {}, input: TSLA },
      { name: "both exist", missing: [], setup: () => chain.current.set(ata(TSLAX, OWNER), tokenAccount(TSLAX, OWNER, 0n)), input: TSLA },
    ];

    for (const { name, missing, setup, input } of cases) {
      it(`${name}: quote shows position rent and new token-account rent separately, and step 1 is capped at exactly their sum`, async () => {
        setup();
        const adapter = createMeteoraDlmmAdapter({ feePolicy: NO_FEE_POLICY });
        const open = { ...request, input: { token: input, amountRaw: DEPOSIT_RAW } };
        const quote = await adapter.quoteOpen(open);
        expect(quote.blockedReason).toBeUndefined();
        const tokenAccountRent = T22_RENT * BigInt(missing.length);
        expect(quote.rent).toEqual({ refundableLamports: String(POSITION_RENT), nonRefundableLamports: "0", tokenAccountLamports: String(tokenAccountRent) });
        const { lines, totalLamports } = openRentLines(quote.rent);
        expect(totalLamports).toBe(POSITION_RENT + tokenAccountRent);
        expect(lines[0]).toBe("Position rent: about 0.0419 SOL, refunded when you close the position.");
        if (missing.length) {
          expect(lines).toEqual([lines[0], `New token-account rent: about ${(Number(tokenAccountRent) / 1e9).toFixed(4)} SOL. Stays in your token account; refundable only if you close that account.`]);
        } else {
          expect(lines).toHaveLength(1);
        }

        // The real chain charges exactly the quoted rent: step 1 passes its SOL cap and names the accounts it creates.
        const step1 = await adapter.prepareOpen(open, { step: 1, priorSignatures: [] });
        expect(step1.createsTokenAccounts ?? []).toEqual(missing.map((mint) => ({ mint, rentLamports: String(T22_RENT) })));
        expect(step1.createsTokenAccounts?.reduce((sum, item) => sum + BigInt(item.rentLamports), 0n) ?? 0n).toBe(BigInt(quote.rent!.tokenAccountLamports!));
        // No fixed SPL size was used for a Token-2022 account.
        expect(chain.current.rentQueries).not.toContain(AccountLayout.span);

        // The cap is the quoted total plus the 15,000-lamport network allowance and nothing else; the fake chain's
        // step 1 pays 10,000 in fees, so created accounts may carry 5,000 lamports more in total, and not one more.
        if (missing.length) {
          const slack = 5_000 / missing.length;
          chain.current.skewTokenAccountRent(slack);
          await expect(adapter.prepareOpen(open, { step: 1, priorSignatures: [] })).resolves.toMatchObject({ step: 1 });
          chain.current.skewTokenAccountRent(slack + 1);
          await expect(adapter.prepareOpen(open, { step: 1, priorSignatures: [] }))
            .rejects.toMatchObject({ code: "UPSTREAM", message: expect.stringMatching(/spends more SOL than the rent and fees shown/) });
        }
      });
    }

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

  describe("too small for the range (quote-time, shared by Open and Add)", () => {
    /** 1:1 legs (fee-free) so the per-bin math is easy to follow; records every leg priced. */
    const legs: { outputMint: string; spend: bigint }[] = [];
    const oneToOne = async ({ outputMint, spend }: { outputMint: string; spend: bigint }) => { legs.push({ outputMint, spend }); return spend; };
    beforeEach(() => { legs.length = 0; installHeldPositions(); });

    it("an open whose split rounds to 0 per bin (40 raw over 29 X / 31 Y bins) is too small, with the minimum (63 raw)", async () => {
      const quote = await createMeteoraDlmmAdapter({ quoteLeg: oneToOne }).quoteOpen({ ...request, input: { token: TSLA, amountRaw: "40" } });
      // X (TSLA, kept) gets 40·57/120 = 19 < 29 bins. Minimum: X needs 29 → ceil(29·120/57) + 1 = 63; Y needs 31 → 61.
      expect(quote.depositMinimum).toEqual({ token: TSLA, tooSmall: true, minimumRaw: "63" });
      // Only the swapped side (TSLAx) is priced; a kept side's output is its own spend.
      expect(legs.every((leg) => leg.outputMint === TSLAX)).toBe(true);
    });

    it("a normal open is not too small", async () => {
      const quote = await createMeteoraDlmmAdapter({ quoteLeg: oneToOne }).quoteOpen(request);
      expect(quote.depositMinimum).toEqual({ token: TSLA, tooSmall: false, minimumRaw: null });
    });

    it("quote-add runs the same check on the owner's position, and refuses a stranger", async () => {
      const adapter = createMeteoraDlmmAdapter({ quoteLeg: oneToOne });
      const key = `meteora-dlmm:${FEED_POSITION}` as const;
      expect(await adapter.quoteAdd!(key, OWNER, { token: TSLA, amountRaw: "40" })).toEqual({ depositMinimum: { token: TSLA, tooSmall: true, minimumRaw: "63" } });
      expect(await adapter.quoteAdd!(key, OWNER, { token: TSLA, amountRaw: DEPOSIT_RAW })).toEqual({ depositMinimum: { token: TSLA, tooSmall: false, minimumRaw: null } });
      await expect(adapter.quoteAdd!(key, STRANGER, { token: TSLA, amountRaw: "40" })).rejects.toMatchObject({ code: "POSITION_NOT_FOUND" });
      expect(chain.current.simulations).toEqual([]);
    });

    it("is best effort: a leg quote that fails leaves the quote without the check (the build's simulation still refuses)", async () => {
      const failing = async () => { throw new Error("Jupiter is busy"); };
      const quote = await createMeteoraDlmmAdapter({ quoteLeg: failing }).quoteOpen({ ...request, input: { token: TSLA, amountRaw: "40" } });
      expect(quote.depositMinimum).toBeUndefined();
      expect(quote.range.units).toBe(60);
    });
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
        () => adapter.prepareCompound(key, STRANGER, first),
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
      await expect(adapter.prepareCompound(key, OWNER, first)).rejects.toMatchObject({ code: "TOKEN_RESTRICTED" });
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

    it("refuses a full withdraw (close) in plain words if the pool has farming rewards set up; partial still works", async () => {
      // Neither RWA pool has rewards today (mainnet check 11/1); this covers a pool that adds them later.
      const pool = chain.current.get(TSLA_POOL)!;
      const data = Buffer.from(pool.data);
      new Keypair().publicKey.toBuffer().copy(data, METEORA_REWARD_INFOS_OFFSET);
      chain.current.set(TSLA_POOL, { ...pool, data });
      const adapter = createMeteoraDlmmAdapter();
      await expect(adapter.prepareWithdraw(key, OWNER, { fraction: 1, output: "pool-tokens" }, first))
        .rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringMatching(/farming rewards.*nothing was built/) });
      expect(chain.current.simulations).toEqual([]);
      await expect(adapter.prepareWithdraw(key, OWNER, { fraction: 0.5, output: "pool-tokens" }, first)).resolves.toMatchObject({ done: true });
    });

    it("lets withdraw and claim reach a position in a pool the feed no longer lists (funds never trapped); add refuses", async () => {
      const unlisted = `meteora-dlmm:${UNLISTED_POSITION}` as const;
      const adapter = createMeteoraDlmmAdapter();
      await expect(adapter.prepareWithdraw(unlisted, OWNER, { fraction: 1, output: "pool-tokens" }, first)).resolves.toMatchObject({ done: true });
      await expect(adapter.prepareAdd(unlisted, OWNER, { token: TSLA, amountRaw: DEPOSIT_RAW }, first)).rejects.toBeInstanceOf(DexError);
      // Compound deposits too, so it follows add: listed pools only (the fees can still be claimed).
      await expect(adapter.prepareCompound(unlisted, OWNER, first)).rejects.toMatchObject({ code: "UNSUPPORTED" });
      await expect(adapter.prepareClaim(unlisted, OWNER, first)).resolves.toMatchObject({ done: true });
    });
  });

  describe("compound (PR8: claim + deposit back, no swap, no fee)", () => {
    const key = `meteora-dlmm:${FEED_POSITION}` as const;
    const first = { step: 1, priorSignatures: [] };
    const METEORA = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
    /** The amounts (X, Y) encoded in the transaction's add_liquidity_by_strategy2, and its static keys. */
    function compoundTx(prepared: { kind: string; transaction?: string }) {
      if (prepared.kind !== "solana-tx" || !prepared.transaction) throw new Error("expected a Solana step");
      const tx = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, "base64"));
      const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
      const meteora = tx.message.compiledInstructions.filter((ix) => keys[ix.programIdIndex] === METEORA).map((ix) => Buffer.from(ix.data));
      return { tx, keys, meteora };
    }
    beforeEach(() => installHeldPositions());

    it("claims and deposits exactly the claimed fees back into the position in one step, with no swap, no fee and no transfer", async () => {
      const step = await createMeteoraDlmmAdapter().prepareCompound(key, OWNER, first);
      expect(step).toMatchObject({ step: 1, of: 1, done: true, label: expect.stringMatching(/add them back into it\. No platform fee\.$/) });
      // The claim alone (to measure it), then claim + deposit.
      expect(chain.current.simulations).toEqual(["claim_fee2", "claim_fee2", "add_liquidity_by_strategy2"]);
      const { tx, keys, meteora } = compoundTx(step.prepared);
      expect(keys[0]).toBe(OWNER);
      expect(tx.message.header.numRequiredSignatures).toBe(1);
      expect(meteora).toHaveLength(2);
      const add = meteora[1]!;
      expect([add.readBigUInt64LE(8), add.readBigUInt64LE(16)]).toEqual([FEED_FEES.x, FEED_FEES.y]);
      expect([add.readInt32LE(32), add.readInt32LE(36)]).toEqual([46031, 46090]); // the position's own range
      expect(keys).not.toContain(FEE_WALLET);
      expect(keys).not.toContain(ata(TSLA, FEE_WALLET));
      expect(keys).not.toContain("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
      // Only the compute budget, the owner's own missing token account (TSLAx) and Meteora: no transfer of any kind.
      const programs = new Set(tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]));
      expect([...programs].sort()).toEqual(["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "ComputeBudget111111111111111111111111111111", METEORA].sort());
      // That created account's rent is returned with the step, so the panel states it before the wallet signs.
      expect(step.createsTokenAccounts).toEqual([{ mint: TSLAX, rentLamports: String(rentFor(RWA_TOKEN_ACCOUNT_SPACE)) }]);
    });

    it("leaves the wallet's own pool tokens untouched when it lands (only the claimed fees go back in)", async () => {
      const before = [chain.current.get(ata(TSLA, OWNER)), chain.current.get(ata(TSLAX, OWNER))];
      const step = await createMeteoraDlmmAdapter().prepareCompound(key, OWNER, first);
      chain.current.land(compoundTx(step.prepared).tx);
      const after = [chain.current.get(ata(TSLA, OWNER)), chain.current.get(ata(TSLAX, OWNER))];
      expect(after[0]!.data.equals(before[0]!.data)).toBe(true);
      expect(after[1]!.data.readBigUInt64LE(64)).toBe(0n); // created by the claim, emptied by the deposit
      expect(before[1]).toBeNull();
      // Nothing left to compound now.
      await expect(createMeteoraDlmmAdapter().prepareCompound(key, OWNER, first)).rejects.toMatchObject({ code: "INVALID_REQUEST", message: expect.stringMatching(/no unclaimed fees/) });
    });

    it("refuses in plain words when there are no fees yet, building nothing", async () => {
      chain.current.setClaimable(FEED_POSITION, 0n, 0n);
      await expect(createMeteoraDlmmAdapter().prepareCompound(key, OWNER, first))
        .rejects.toMatchObject({ code: "INVALID_REQUEST", message: "This position has no unclaimed fees yet, so there is nothing to compound." });
      expect(chain.current.simulations).toEqual(["claim_fee2"]); // the measuring simulation only
    });

    it("out of range, deposits only the token the range can hold and says the rest goes to the wallet", async () => {
      // 46070..46089 sits above the active bin (46062): it can only hold TSLA (X).
      chain.current.set(FEED_POSITION, positionAccount(TSLA_POOL, OWNER, 46070, 20, FEED_SHARE));
      const step = await createMeteoraDlmmAdapter().prepareCompound(key, OWNER, first);
      const add = compoundTx(step.prepared).meteora[1]!;
      expect([add.readBigUInt64LE(8), add.readBigUInt64LE(16)]).toEqual([FEED_FEES.x, 0n]);
      expect(step.label).toMatch(/outside the position's range.*go to your wallet instead/);
    });

    it("refuses when an out-of-range position's fees are all in the token it can't hold (claim instead)", async () => {
      // 46031..46050 sits below the active bin: it can only hold TSLAx (Y); the fees are all TSLA.
      chain.current.set(FEED_POSITION, positionAccount(TSLA_POOL, OWNER, 46031, 20, FEED_SHARE));
      chain.current.setClaimable(FEED_POSITION, 900n, 0n);
      await expect(createMeteoraDlmmAdapter().prepareCompound(key, OWNER, first))
        .rejects.toMatchObject({ code: "INVALID_REQUEST", message: expect.stringMatching(/Claim them to your wallet instead/) });
    });

    it("declares compound with no fee rule (PM 11/1)", () => {
      const { descriptor } = createMeteoraDlmmAdapter();
      expect(descriptor.capabilities.compound).toEqual({ supported: true });
      expect(descriptor.meta.feePolicy.compound).toEqual({ kind: "none" });
    });
  });

  describe("fee amounts (PM: exactly 10 bps on the swap leg, 0 with no swap)", () => {
    const first = { step: 1, priorSignatures: [] };
    /** Records every Jupiter quote the adapter asks for (amount and fee bps), answering from the replay. */
    function recordQuotes() {
      const quotes: { inputMint: string; outputMint: string; amount: bigint; platformFeeBps: number }[] = [];
      const restore = setFetchReplay(async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/quote")) {
          quotes.push({ inputMint: parsed.searchParams.get("inputMint")!, outputMint: parsed.searchParams.get("outputMint")!,
            amount: BigInt(parsed.searchParams.get("amount")!), platformFeeBps: Number(parsed.searchParams.get("platformFeeBps") ?? 0) });
        }
        const replay = jupiterReplay(url, init);
        if (!replay) throw new Error(`no fixture replay for ${parsed.host}`);
        return replay;
      });
      return { quotes, restore };
    }
    const tenBps = (amount: bigint) => amount * 10n / 10_000n;
    /** Standard 60-bin range wholly above the active bin 46062: only TSLA (X) is needed, so a TSLA deposit swaps nothing. */
    const ABOVE = { kind: "units", lower: 46063, upper: 46090 } as const;
    const ABOVE_POSITION = Keypair.fromSeed(new Uint8Array(32).fill(25)).publicKey.toBase58();

    it("open: the quoted fee is exactly 10 bps of the swapped TSLAx leg; the kept TSLA side is neither swapped nor charged", async () => {
      const { quotes, restore } = recordQuotes();
      try {
        const adapter = createMeteoraDlmmAdapter();
        const quote = await adapter.quoteOpen(request);
        expect(ySpend).toBeGreaterThan(0n);
        expect(BigInt(DEPOSIT_RAW) - ySpend).toBeGreaterThan(0n); // part of the deposit stays TSLA
        expect(quote.platformFeeRaw).toBe(tenBps(ySpend).toString());
        expect(adapter.fees.feeFor("open", ySpend)).toBe(tenBps(ySpend));
        const setup = await adapter.prepareOpen(request, first); // step 1 builds no swap: it must succeed, not be swallowed
        expect(setup).toMatchObject({ step: 1, done: false });
        expect(quotes.length).toBeGreaterThan(0);
        for (const q of quotes) expect(q).toMatchObject({ inputMint: TSLA, outputMint: TSLAX, amount: ySpend, platformFeeBps: 10 });
      } finally { restore(); }
    });

    it("open: no swap leg means a fee of exactly 0 and no fee account", async () => {
      const { quotes, restore } = recordQuotes();
      try {
        const quote = await createMeteoraDlmmAdapter().quoteOpen({ ...base, range: ABOVE });
        expect(quote.blockedReason).toBeUndefined();
        expect(quote.platformFeeRaw).toBe("0");
        expect(quotes).toEqual([]);
      } finally { restore(); }
    });

    it("add: the Jupiter leg carries 10 bps of the swapped amount only (fee = floor(swapped × 10 / 10000))", async () => {
      installHeldPositions();
      const { quotes, restore } = recordQuotes();
      try {
        const adapter = createMeteoraDlmmAdapter();
        const step = await adapter.prepareAdd(`meteora-dlmm:${FEED_POSITION}`, OWNER, { token: TSLA, amountRaw: DEPOSIT_RAW }, first);
        expect(quotes.length).toBeGreaterThan(0);
        for (const q of quotes) expect(q).toMatchObject({ inputMint: TSLA, outputMint: TSLAX, amount: ySpend, platformFeeBps: 10 });
        expect(adapter.fees.feeFor("add", ySpend)).toBe(tenBps(ySpend));
        // The fee lands in the fee wallet's existing TSLA account, as an account of the Jupiter swap instruction itself,
        // and nothing in the transaction creates an associated token account for the fee wallet.
        const feeAta = ata(TSLA, FEE_WALLET);
        const instructions = compiledInstructions(step.prepared);
        const jupiter = instructions.filter((ix) => ix.program === JUPITER_PROGRAM);
        expect(jupiter.length).toBeGreaterThan(0);
        expect(jupiter.some((ix) => ix.accounts.includes(feeAta))).toBe(true);
        const ataCreates = instructions.filter((ix) => ix.program === ATA_PROGRAM);
        for (const ix of ataCreates) {
          expect(ix.accounts).not.toContain(feeAta);
          expect(ix.accounts).not.toContain(FEE_WALLET);
        }
      } finally { restore(); }
    });

    it("add: no swap leg means no Jupiter call, no fee account, fee 0", async () => {
      chain.current.set(ABOVE_POSITION, positionAccount(TSLA_POOL, OWNER, ABOVE.lower, ABOVE.upper - ABOVE.lower + 1, 5n));
      const { quotes, restore } = recordQuotes();
      try {
        const step = await createMeteoraDlmmAdapter().prepareAdd(`meteora-dlmm:${ABOVE_POSITION}`, OWNER, { token: TSLA, amountRaw: DEPOSIT_RAW }, first);
        expect(quotes).toEqual([]);
        if (step.prepared.kind !== "solana-tx") throw new Error("expected a Solana step");
        const keys = VersionedTransaction.deserialize(Buffer.from(step.prepared.transaction, "base64")).message.staticAccountKeys.map((k) => k.toBase58());
        expect(keys).not.toContain("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
        expect(keys).not.toContain(ata(TSLA, FEE_WALLET));
        expect(keys).not.toContain(FEE_WALLET);
      } finally { restore(); }
    });
  });
});

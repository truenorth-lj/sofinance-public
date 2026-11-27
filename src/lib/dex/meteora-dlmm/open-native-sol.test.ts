import { AccountLayout, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type AccountInfo, type TransactionInstruction } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NATIVE_SOL_MINT } from "@sofinance/engine/ids";
import { decodeLbPair } from "@sofinance/engine/protocols/meteora/accounts";
import { METEORA_DLMM_PROGRAM_ID } from "@sofinance/engine/protocols/meteora/constants";
import { meteoraSpotSplit, METEORA_IX_DISCRIMINATOR } from "@sofinance/engine/protocols/meteora/open";
import { JUPITER_API_HOST } from "@sofinance/engine/jupiter/urls";
import { setFetchReplay } from "@/lib/test-support/offline-fetch";
import { MeteoraSystemTransferError } from "@/lib/meteora-open";
import type { OpenRequest, StepResult } from "../adapter";
import { openSolNeed, openSolPartsFromQuote } from "../sol-need";
import { createMeteoraDlmmAdapter } from "./adapter.server";
import { positionAccount } from "./meteora-dlmm.fixtures";

/**
 * Native SOL into the Meteora SOL/hSOL DLMM pool (6a7E…, X = hSOL, Y = wSOL), offline. The pool, its two SPL mints and
 * which bin arrays exist come from a read-only mainnet capture (packages/engine/src/fixtures/meteora-dlmm-sol-hsol.json).
 * The fake RPC below plays every instruction these steps emit (ATA create, SOL transfer, sync_native, close, the two
 * Meteora instructions and a Jupiter leg that debits exactly its input), so the tests read real balances out of
 * simulation and landing. Wallets, the fee wallet and the blockhash are synthetic keys.
 */
const chain = vi.hoisted(() => ({ current: undefined as unknown as ReturnType<typeof createChain> }));
vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sofinance/engine/rpc")>()),
  rpcConnection: () => chain.current.connection,
}));

type Capture = { slot: number; pools: Record<string, { owner: string; data: string; binArrays: Record<string, { address: string; exists: boolean }> }>; mints: Record<string, { owner: string; data: string }> };
const capture: Capture = JSON.parse(readFileSync(new URL("../../../../packages/engine/src/fixtures/meteora-dlmm-sol-hsol.json", import.meta.url), "utf8"));
const POOL = "6a7EnjAoiRBbminKkWPdytMFFf5ogjLutqwpvAVyZ89j";
const pair = decodeLbPair(Buffer.from(capture.pools[POOL]!.data, "base64"));
const HSOL = pair.tokenXMint;
const seeded = (byte: number) => Keypair.fromSeed(new Uint8Array(32).fill(byte)).publicKey.toBase58();
const OWNER = seeded(31), FEE_WALLET = seeded(32), POSITION = seeded(33), BLOCKHASH = seeded(34);
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const rentFor = (size: number) => (128 + size) * 5_080;
const TOKEN_ACCOUNT_RENT = rentFor(165);
const ata = (mint: string, owner: string) => getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true, TOKEN_PROGRAM_ID).toBase58();
const WSOL_ATA = ata(NATIVE_SOL_MINT, OWNER);
const HSOL_ATA = ata(HSOL, OWNER);
/** hSOL per SOL the fake Jupiter leg pays (1 hSOL ≈ 1.198 SOL). */
const HSOL_PER_SOL = (raw: bigint) => raw * 834n / 1_000n;
const OWNER_LAMPORTS = 2_000_000_000n;
const DEPOSIT = 500_000_000n; // 0.5 SOL
// 12 bins around the active bin 1796 (bin step 1), all in bin array 25, which exists.
const RANGE = { kind: "units" as const, lower: 1790, upper: 1801 };
const request: OpenRequest = { poolId: POOL, owner: OWNER, range: RANGE, input: { token: NATIVE_SOL_MINT, amountRaw: DEPOSIT.toString() }, slippageBps: 50, cosigner: POSITION };
const split = meteoraSpotSplit(DEPOSIT, pair.activeId, RANGE.lower, RANGE.upper);

type Account = AccountInfo<Buffer>;
const account = (owner: string, data: Buffer, lamports: number): Account => ({ owner: new PublicKey(owner), data, lamports, executable: false, rentEpoch: 0 });
function splToken(mint: string, owner: string, amount: bigint, extraLamports = 0n): Account {
  const data = Buffer.alloc(165);
  const native = mint === NATIVE_SOL_MINT;
  AccountLayout.encode({
    mint: new PublicKey(mint), owner: new PublicKey(owner), amount, delegateOption: 0, delegate: PublicKey.default, state: 1,
    isNativeOption: native ? 1 : 0, isNative: native ? BigInt(TOKEN_ACCOUNT_RENT) : 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default,
  }, data);
  return account(TOKEN_PROGRAM_ID.toBase58(), data, TOKEN_ACCOUNT_RENT + Number(native ? amount : 0n) + Number(extraLamports));
}
const amountOf = (info: Account | undefined) => (info ? AccountLayout.decode(info.data).amount : 0n);

function createChain() {
  const accounts = new Map<string, Account>();
  const pool = capture.pools[POOL]!;
  accounts.set(POOL, account(pool.owner, Buffer.from(pool.data, "base64"), 1));
  for (const array of Object.values(pool.binArrays)) if (array.exists) accounts.set(array.address, account(METEORA_DLMM_PROGRAM_ID, Buffer.alloc(8), 1));
  for (const [mint, recorded] of Object.entries(capture.mints)) accounts.set(mint, account(recorded.owner, Buffer.from(recorded.data, "base64"), 1));
  accounts.set(OWNER, account(SystemProgram.programId.toBase58(), Buffer.alloc(0), Number(OWNER_LAMPORTS)));
  // The fee wallet's wSOL account exists (the policy assumes it; Raydium SOL deposits pay into it today).
  accounts.set(ata(NATIVE_SOL_MINT, FEE_WALLET), splToken(NATIVE_SOL_MINT, FEE_WALLET, 0n));
  const log: string[] = [];

  const lamports = (map: Map<string, Account>, key: string, delta: bigint) => {
    const info = map.get(key)!;
    const next = BigInt(info.lamports) + delta;
    if (next < 0n) throw new Error(`insufficient lamports in ${key}`);
    map.set(key, { ...info, lamports: Number(next) });
  };
  const setAmount = (map: Map<string, Account>, key: string, amount: bigint) => {
    const info = map.get(key);
    if (!info) throw new Error(`missing token account ${key}`);
    if (amount < 0n) throw new Error(`insufficient token balance in ${key}`);
    const decoded = AccountLayout.decode(info.data);
    const data = Buffer.alloc(165);
    AccountLayout.encode({ ...decoded, amount }, data);
    map.set(key, { ...info, data });
  };

  function run(ix: TransactionInstruction, next: Map<string, Account>, payer: string) {
    const program = ix.programId.toBase58();
    const key = (i: number) => ix.keys[i]!.pubkey.toBase58();
    if (ix.programId.equals(ComputeBudgetProgram.programId)) return;
    if (program === ATA_PROGRAM) {
      if (!next.has(key(1))) {
        log.push("create_ata");
        next.set(key(1), splToken(key(3), key(2), 0n));
        lamports(next, key(0), -BigInt(TOKEN_ACCOUNT_RENT));
      }
      return;
    }
    if (ix.programId.equals(SystemProgram.programId) && ix.data.readUInt32LE(0) === 2) {
      log.push("system_transfer");
      const amount = ix.data.readBigUInt64LE(4);
      lamports(next, key(0), -amount);
      lamports(next, key(1), amount);
      return;
    }
    if (ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data[0] === 17) {
      log.push("sync_native");
      setAmount(next, key(0), BigInt(next.get(key(0))!.lamports - TOKEN_ACCOUNT_RENT));
      return;
    }
    if (ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data[0] === 9) {
      log.push("close_account");
      lamports(next, key(1), BigInt(next.get(key(0))!.lamports));
      next.delete(key(0));
      return;
    }
    if (program === JUPITER) {
      log.push("jupiter_swap");
      const [inAmount, outAmount] = [ix.data.readBigUInt64LE(8), ix.data.readBigUInt64LE(16)];
      const source = key(1), destination = key(2);
      setAmount(next, source, amountOf(next.get(source)) - inAmount);
      if (AccountLayout.decode(next.get(source)!.data).isNativeOption) lamports(next, source, -inAmount);
      setAmount(next, destination, amountOf(next.get(destination)) + outAmount);
      return;
    }
    if (program === METEORA_DLMM_PROGRAM_ID) {
      const data = Buffer.from(ix.data);
      const tag = data.subarray(0, 8).toString("hex");
      if (tag === METEORA_IX_DISCRIMINATOR.initializePosition) {
        log.push("initialize_position");
        const position = positionAccount(key(2), key(3), data.readInt32LE(8), data.readInt32LE(12));
        next.set(key(1), position);
        lamports(next, payer, -BigInt(position.lamports));
        return;
      }
      if (tag === METEORA_IX_DISCRIMINATOR.addLiquidityByStrategy2) {
        log.push("add_liquidity_by_strategy2");
        const [amountX, amountY] = [data.readBigUInt64LE(8), data.readBigUInt64LE(16)];
        const position = next.get(key(0))!;
        const filled = Buffer.from(position.data);
        filled.writeBigUInt64LE(filled.readBigUInt64LE(72) + 1_000_000n, 72);
        next.set(key(0), { ...position, data: filled });
        const x = ata(HSOL, payer), y = ata(NATIVE_SOL_MINT, payer);
        setAmount(next, x, amountOf(next.get(x)) - amountX);
        setAmount(next, y, amountOf(next.get(y)) - amountY);
        lamports(next, y, -amountY);
        return;
      }
    }
    throw new Error(`fake chain: unexpected instruction for ${program}`);
  }

  function execute(tx: VersionedTransaction) {
    const next = new Map(accounts);
    const message = TransactionMessage.decompile(tx.message);
    for (const ix of message.instructions) run(ix, next, message.payerKey.toBase58());
    lamports(next, message.payerKey.toBase58(), -5_000n * BigInt(tx.message.header.numRequiredSignatures));
    return next;
  }
  const encoded = (info: Account | undefined) => info
    ? { data: [info.data.toString("base64"), "base64"], owner: info.owner.toBase58(), lamports: info.lamports, executable: false, rentEpoch: 0 }
    : null;
  const get = (key: PublicKey) => accounts.get(key.toBase58()) ?? null;
  const connection = {
    async getMultipleAccountsInfoAndContext(keys: PublicKey[]) { return { context: { slot: capture.slot }, value: keys.map(get) }; },
    async getMultipleAccountsInfo(keys: PublicKey[]) { return keys.map(get); },
    async getAccountInfo(key: PublicKey) { return get(key); },
    async getAccountInfoAndContext(key: PublicKey) { return { context: { slot: capture.slot }, value: get(key) }; },
    async getMinimumBalanceForRentExemption(size: number) { return rentFor(size); },
    async getLatestBlockhash() { return { blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 }; },
    async getAddressLookupTable() { return { context: { slot: capture.slot }, value: null }; },
    async simulateTransaction(tx: VersionedTransaction, config?: { accounts?: { addresses: string[] } }) {
      try {
        const next = execute(tx);
        return { context: { slot: capture.slot }, value: { err: null, logs: [], unitsConsumed: 60_000, accounts: (config?.accounts?.addresses ?? []).map((a) => encoded(next.get(a))) } };
      } catch (error) {
        return { context: { slot: capture.slot }, value: { err: { fake: String(error) }, logs: [String(error)], unitsConsumed: 0, accounts: null } };
      }
    },
  };
  return {
    connection: connection as never, accounts, log,
    land(prepared: StepResult["prepared"]) {
      if (prepared.kind !== "solana-tx") throw new Error("expected a Solana step");
      const next = execute(VersionedTransaction.deserialize(Buffer.from(prepared.transaction, "base64")));
      accounts.clear();
      for (const [k, v] of next) accounts.set(k, v);
    },
  };
}

/** Jupiter for this pool: wSOL → hSOL at HSOL_PER_SOL; the swap instruction carries its in / out amounts for the fake chain. */
function jupiter(url: string, init?: RequestInit): Response | undefined {
  const parsed = new URL(url);
  if (parsed.host !== JUPITER_API_HOST) return undefined;
  if (parsed.pathname.endsWith("/quote")) {
    const params = parsed.searchParams;
    const amount = BigInt(params.get("amount")!);
    const bps = Number(params.get("platformFeeBps") ?? 0);
    const out = HSOL_PER_SOL(amount - amount * BigInt(bps) / 10_000n);
    return Response.json({
      inputMint: params.get("inputMint"), outputMint: params.get("outputMint"), inAmount: amount.toString(), outAmount: out.toString(),
      otherAmountThreshold: (out * 9_950n / 10_000n).toString(), swapMode: "ExactIn", slippageBps: Number(params.get("slippageBps")),
      platformFee: bps ? { amount: (amount * BigInt(bps) / 10_000n).toString(), feeBps: bps } : null, priceImpactPct: "0.0001",
      routePlan: [{ percent: 100, swapInfo: { ammKey: POOL, label: "Meteora DLMM", inputMint: params.get("inputMint"), outputMint: params.get("outputMint"), inAmount: amount.toString(), outAmount: out.toString() } }],
      contextSlot: capture.slot, timeTaken: 0.01,
    });
  }
  if (parsed.pathname.endsWith("/swap-instructions")) {
    const body = JSON.parse(String(init?.body)) as { userPublicKey: string; feeAccount?: string; wrapAndUnwrapSol?: boolean; quoteResponse: { inputMint: string; outputMint: string; inAmount: string; otherAmountThreshold: string } };
    if (body.wrapAndUnwrapSol) throw new Error("the deposit leg must spend the wSOL account, never wrap on its own");
    const user = body.userPublicKey;
    const data = Buffer.alloc(24);
    Buffer.from("e517cb977ae3ad2a", "hex").copy(data, 0);
    data.writeBigUInt64LE(BigInt(body.quoteResponse.inAmount), 8);
    data.writeBigUInt64LE(BigInt(body.quoteResponse.otherAmountThreshold), 16);
    return Response.json({
      computeBudgetInstructions: [], setupInstructions: [], cleanupInstruction: null, otherInstructions: [], addressLookupTableAddresses: [],
      swapInstruction: {
        programId: JUPITER,
        accounts: [
          { pubkey: user, isSigner: true, isWritable: true },
          { pubkey: ata(body.quoteResponse.inputMint, user), isSigner: false, isWritable: true },
          { pubkey: ata(body.quoteResponse.outputMint, user), isSigner: false, isWritable: true },
          ...(body.feeAccount ? [{ pubkey: body.feeAccount, isSigner: false, isWritable: true }] : []),
        ],
        data: data.toString("base64"),
      },
      prioritizationFeeLamports: 0,
    });
  }
  return undefined;
}

/** Program + data tag of each instruction of a prepared step, in order. */
function sequence(prepared: StepResult["prepared"]) {
  if (prepared.kind !== "solana-tx") throw new Error("expected a Solana step");
  const message = TransactionMessage.decompile(VersionedTransaction.deserialize(Buffer.from(prepared.transaction, "base64")).message);
  return message.instructions.map((ix) => {
    const program = ix.programId.toBase58();
    if (ix.programId.equals(ComputeBudgetProgram.programId)) return "compute_budget";
    if (program === ATA_PROGRAM) return `create_ata:${ix.keys[1]!.pubkey.toBase58() === WSOL_ATA ? "wsol" : ix.keys[1]!.pubkey.toBase58() === HSOL_ATA ? "hsol" : "other"}`;
    if (ix.programId.equals(SystemProgram.programId)) return `system:${ix.data.readUInt32LE(0)}:${ix.keys[0]!.pubkey.toBase58() === OWNER ? "owner" : "?"}->${ix.keys[1]!.pubkey.toBase58() === WSOL_ATA ? "wsol" : "?"}:${ix.data.readBigUInt64LE(4)}`;
    if (ix.programId.equals(TOKEN_PROGRAM_ID)) return ix.data[0] === 17 ? "sync_native" : ix.data[0] === 9 ? `close:${ix.keys[0]!.pubkey.toBase58() === WSOL_ATA ? "wsol" : "?"}` : `token:${ix.data[0]}`;
    if (program === JUPITER) return "jupiter";
    if (program === METEORA_DLMM_PROGRAM_ID) {
      const tag = Buffer.from(ix.data).subarray(0, 8).toString("hex");
      return tag === METEORA_IX_DISCRIMINATOR.initializePosition ? "initialize_position" : tag === METEORA_IX_DISCRIMINATOR.addLiquidityByStrategy2 ? "add_liquidity_by_strategy2" : `meteora:${tag}`;
    }
    return program;
  });
}

const adapter = () => createMeteoraDlmmAdapter({
  listedPool: async (poolId) => (poolId === POOL ? { poolId, mints: [HSOL, NATIVE_SOL_MINT], binStep: 1, source: "allowlist" } : null),
  quoteLeg: async ({ spend }) => HSOL_PER_SOL(spend),
  usdPrices: async () => new Map(),
});

describe("Meteora SOL/hSOL: native SOL as the open input", () => {
  let teardown: () => void;
  beforeEach(() => {
    chain.current = createChain();
    vi.stubEnv("SOFINANCE_FEE_WALLET", FEE_WALLET);
    vi.stubEnv("SOFINANCE_FEE_BPS", "10");
    vi.stubEnv("JUPITER_API_KEY", "fixture-key");
    const restoreFetch = setFetchReplay(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const replay = jupiter(url, init);
      if (!replay) throw new Error(`no fixture replay for ${new URL(url).host}`);
      return replay;
    });
    teardown = () => { restoreFetch(); vi.unstubAllEnvs(); };
  });
  afterEach(() => teardown());

  it("quotes three steps with the SOL deposit in the SOL need, and the 10 bps only on the swapped hSOL side", async () => {
    const quote = await adapter().quoteOpen(request);
    expect(quote.blockedReason).toBeUndefined();
    expect(quote.steps).toBe(3);
    // 4 signatures (setup: wallet + position, wrap, deposit), the reserve, and the deposit itself.
    expect(quote.sol).toMatchObject({ networkFeeLamports: "20000", reserveLamports: "10000000", inputLamports: DEPOSIT.toString() });
    // Y (wSOL) is kept as is and never charged; X (hSOL) is bought from wSOL and pays floor(spend × 10 / 10,000).
    expect(quote.platformFeeRaw).toBe((split.x * 10n / 10_000n).toString());
    // The dialog adds the same parts: the deposit is part of the SOL the wallet needs.
    const rent = BigInt(quote.rent!.refundableLamports) + BigInt(quote.rent!.tokenAccountLamports ?? "0");
    const parts = openSolPartsFromQuote(rent, quote.sol);
    if (!parts.ok) throw new Error(parts.reason);
    expect(openSolNeed(parts.parts)).toBe(rent + 20_000n + BigInt(quote.sol!.swapAccountsLamports) + 10_000_000n + DEPOSIT);
  });

  it("walks setup → wrap → deposit: exact instruction sequences, amounts, and the wSOL account closed at the end", async () => {
    const a = adapter();
    const chainNow = chain.current;

    const step1 = await a.prepareOpen(request, { step: 1, priorSignatures: [] });
    expect(step1).toMatchObject({ step: 1, of: 3, done: false, planToken: POSITION, label: "Create the position account (step 1 of 3)" });
    // Setup is unchanged: the wallet's two pool-token accounts + initialize_position; no SOL transfer.
    expect(sequence(step1.prepared)).toEqual(["compute_budget", "create_ata:hsol", "create_ata:wsol", "initialize_position"]);
    chainNow.land(step1.prepared);
    const afterSetup = BigInt(chainNow.accounts.get(OWNER)!.lamports);

    const step2 = await a.prepareOpen(request, { step: 2, priorSignatures: ["s1"], planToken: POSITION });
    expect(step2).toMatchObject({ step: 2, of: 3, done: false, planToken: POSITION, label: "Wrap your SOL for the deposit (step 2 of 3)" });
    // A plain wrap: create-idempotent (already there), exactly the deposit into the wallet's own wSOL account, sync.
    expect(sequence(step2.prepared)).toEqual(["compute_budget", "create_ata:wsol", `system:2:owner->wsol:${DEPOSIT}`, "sync_native"]);
    chainNow.land(step2.prepared);
    expect(amountOf(chainNow.accounts.get(WSOL_ATA))).toBe(DEPOSIT);
    expect(afterSetup - BigInt(chainNow.accounts.get(OWNER)!.lamports)).toBe(DEPOSIT + 5_000n);

    const step3 = await a.prepareOpen(request, { step: 3, priorSignatures: ["s1", "s2"], planToken: POSITION });
    expect(step3).toMatchObject({ step: 3, of: 3, done: true, label: "Deposit into the position (step 3 of 3)" });
    // wSOL → hSOL for the X side only (from the wSOL account, Jupiter never wraps), add, then close the wSOL account.
    expect(sequence(step3.prepared)).toEqual(["compute_budget", "jupiter", "add_liquidity_by_strategy2", "close:wsol"]);
    if (step3.prepared.kind !== "solana-tx") throw new Error("expected a Solana step");
    const message = TransactionMessage.decompile(VersionedTransaction.deserialize(Buffer.from(step3.prepared.transaction, "base64")).message);
    const add = message.instructions.find((ix) => ix.programId.toBase58() === METEORA_DLMM_PROGRAM_ID)!;
    const swap = message.instructions.find((ix) => ix.programId.toBase58() === JUPITER)!;
    // Leg spends the X share of the deposit; the add puts the Y share in as wSOL and the leg's minimum out as hSOL.
    expect(swap.data.readBigUInt64LE(8)).toBe(split.x);
    expect(add.data.readBigUInt64LE(16)).toBe(split.y);
    expect(add.data.readBigUInt64LE(8)).toBe(swap.data.readBigUInt64LE(16));
    expect(swap.keys.map((k) => k.pubkey.toBase58())).toContain(ata(NATIVE_SOL_MINT, FEE_WALLET)); // fee inside the swap, in wSOL
    expect(message.instructions.flatMap((ix) => ix.keys).some((k) => k.pubkey.toBase58() === FEE_WALLET)).toBe(false);

    const beforeDeposit = BigInt(chainNow.accounts.get(OWNER)!.lamports);
    chainNow.land(step3.prepared);
    expect(chainNow.accounts.has(WSOL_ATA)).toBe(false);
    // Closing returns the wSOL account's rent (leftover wSOL would come back too); the only cost is the signature.
    expect(BigInt(chainNow.accounts.get(OWNER)!.lamports) - beforeDeposit).toBe(BigInt(TOKEN_ACCOUNT_RENT) - 5_000n);
  });

  it("keeps wSOL the wallet already held: wraps only the deposit, spends only it, and leaves the account open", async () => {
    const own = 7_000_000n;
    chain.current.accounts.set(WSOL_ATA, splToken(NATIVE_SOL_MINT, OWNER, own));
    const a = adapter();
    chain.current.land((await a.prepareOpen(request, { step: 1, priorSignatures: [] })).prepared);
    const step2 = await a.prepareOpen(request, { step: 2, priorSignatures: ["s1"], planToken: POSITION });
    expect(sequence(step2.prepared)).toContain(`system:2:owner->wsol:${DEPOSIT}`);
    chain.current.land(step2.prepared);
    const step3 = await a.prepareOpen(request, { step: 3, priorSignatures: ["s1", "s2"], planToken: POSITION });
    expect(sequence(step3.prepared)).toEqual(["compute_budget", "jupiter", "add_liquidity_by_strategy2"]);
    chain.current.land(step3.prepared);
    expect(amountOf(chain.current.accounts.get(WSOL_ATA))).toBe(own);
  });

  it("refuses up front when the wallet can't cover the deposit plus rent, fees and reserve", async () => {
    chain.current.accounts.set(OWNER, account(SystemProgram.programId.toBase58(), Buffer.alloc(0), Number(DEPOSIT + 40_000_000n)));
    await expect(adapter().prepareOpen(request, { step: 1, priorSignatures: [] }))
      .rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS", message: expect.stringMatching(/your 0\.5000 SOL deposit/) });
  });

  it("wrap refuses before step 1 has landed, and when SOL left would not cover step 3", async () => {
    const a = adapter();
    await expect(a.prepareOpen(request, { step: 2, priorSignatures: ["s1"], planToken: POSITION })).rejects.toMatchObject({ code: "POSITION_NOT_FOUND" });
    chain.current.land((await a.prepareOpen(request, { step: 1, priorSignatures: [] })).prepared);
    // The SOL went elsewhere between steps: keep just under the deposit + 3/3's needs.
    chain.current.accounts.set(OWNER, account(SystemProgram.programId.toBase58(), Buffer.alloc(0), Number(DEPOSIT + 10_000_000n)));
    await expect(a.prepareOpen(request, { step: 2, priorSignatures: ["s1"], planToken: POSITION }))
      .rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS", message: expect.stringMatching(/Not enough SOL to wrap/) });
  });

  it("deposit refuses until the wrap has landed (no wrapped SOL yet)", async () => {
    const a = adapter();
    chain.current.land((await a.prepareOpen(request, { step: 1, priorSignatures: [] })).prepared);
    await expect(a.prepareOpen(request, { step: 3, priorSignatures: ["s1", "s2"], planToken: POSITION }))
      .rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS", message: expect.stringMatching(/wrapped SOL from step 2 of 3/) });
  });

  it("a token input in the same pool stays two steps with no wrap", async () => {
    chain.current.accounts.set(HSOL_ATA, splToken(HSOL, OWNER, 1_000_000_000n));
    chain.current.accounts.set(ata(HSOL, FEE_WALLET), splToken(HSOL, FEE_WALLET, 0n));
    const tokenRequest = { ...request, input: { token: HSOL, amountRaw: "100000000" } };
    const quote = await adapter().quoteOpen(tokenRequest);
    expect(quote.steps).toBe(2);
    expect(quote.sol?.inputLamports).toBeUndefined();
    const step1 = await adapter().prepareOpen(tokenRequest, { step: 1, priorSignatures: [] });
    expect(step1).toMatchObject({ of: 2 });
    expect(sequence(step1.prepared)).not.toContain("sync_native");
  });

  it("Add never takes native SOL, even in this pool", async () => {
    chain.current.accounts.set(POSITION, positionAccount(POOL, OWNER, RANGE.lower, RANGE.upper - RANGE.lower + 1, 1_000_000n));
    await expect(adapter().prepareAdd!(`meteora-dlmm:${POSITION}`, OWNER, { token: NATIVE_SOL_MINT, amountRaw: "1000" }, { step: 1, priorSignatures: [] }))
      .rejects.toMatchObject({ code: "INPUT_TOKEN_UNSUPPORTED", message: expect.stringMatching(/SOL can't be added/) });
  });
});

describe("assertMeteoraWrapRule", () => {
  it("accepts only one transfer of exactly the deposit, from the wallet into its own wSOL account", async () => {
    const { assertMeteoraWrapRule } = await import("@/lib/meteora-open");
    const { wrapNativeSolInstructions } = await import("@sofinance/engine/swap/collection");
    const owner = new PublicKey(OWNER);
    const config = { wallet: new PublicKey(FEE_WALLET), bps: 10 };
    expect(() => assertMeteoraWrapRule(wrapNativeSolInstructions(owner, 5n), owner, 5n, config)).not.toThrow();
    expect(() => assertMeteoraWrapRule(wrapNativeSolInstructions(owner, 6n), owner, 5n, config)).toThrow(MeteoraSystemTransferError);
    expect(() => assertMeteoraWrapRule([...wrapNativeSolInstructions(owner, 5n), SystemProgram.transfer({ fromPubkey: owner, toPubkey: new PublicKey(seeded(40)), lamports: 1 })], owner, 5n, config))
      .toThrow(MeteoraSystemTransferError);
    expect(() => assertMeteoraWrapRule([SystemProgram.transfer({ fromPubkey: owner, toPubkey: new PublicKey(seeded(40)), lamports: 5 })], owner, 5n, config))
      .toThrow(MeteoraSystemTransferError);
    expect(() => assertMeteoraWrapRule([SystemProgram.transfer({ fromPubkey: owner, toPubkey: new PublicKey(FEE_WALLET), lamports: 5 })], owner, 5n, config)).toThrow();
  });
});

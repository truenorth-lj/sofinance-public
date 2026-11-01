/**
 * Test-only fake Solana chain for the Meteora DLMM adapter, built from the recorded public mainnet capture
 * `packages/engine/src/fixtures/meteora-dlmm-rwa-t22.json` (RWA pools 8k2c TSLA/TSLAx and 5pw5 SPCX/SPCXx, both
 * Token-2022 on both sides, slot 464,010,023). Wallets, the fee wallet and the blockhash are synthetic keys; nothing
 * here touches the network or holds a secret.
 *
 * `simulateTransaction` plays the Meteora program: `initialize_position` creates the position (and the step is then
 * treated as landed, with the wallet's missing pool-token account created), `add_liquidity_by_strategy2` fills it and
 * `close_position2` closes it and refunds the rent. Jupiter is answered by `jupiterReplay` (quote + swap-instructions).
 */
import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { AccountLayout, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, type AccountInfo, type VersionedTransaction } from "@solana/web3.js";
import { BIN_ARRAY_DISCRIMINATOR, decodeLbPair } from "@sofinance/engine/protocols/meteora/accounts";
import { METEORA_DLMM_PROGRAM_ID } from "@sofinance/engine/protocols/meteora/constants";
import { METEORA_IX_DISCRIMINATOR } from "@sofinance/engine/protocols/meteora/open";
import { METEORA_POSITION_V2_DISCRIMINATOR } from "@sofinance/engine/protocols/meteora/position";
import { JUPITER_API_HOST } from "@sofinance/engine/jupiter/urls";

type Capture = {
  slot: number;
  pools: Record<string, { owner: string; data: string; bitmapExtension: { address: string; exists: boolean }; binArrays: Record<string, { address: string; exists: boolean }> }>;
  mints: Record<string, { owner: string; data: string }>;
  rentExemptMinimum: Record<string, number>;
};

export const capture: Capture = JSON.parse(readFileSync(new URL("../../../../packages/engine/src/fixtures/meteora-dlmm-rwa-t22.json", import.meta.url), "utf8"));
export const TSLA_POOL = "8k2c9Kiavx5pbWc2dmzhL7vFp11sLgMcKFfSueq8haAh";
export const SPCX_POOL = "5pw5tNUaZJpUCnYjZ1V3gd7XkLbrb4zA9pir4LFph2mj";
export const tslaPair = decodeLbPair(Buffer.from(capture.pools[TSLA_POOL]!.data, "base64"));
export const TSLA = tslaPair.tokenXMint;
export const TSLAX = tslaPair.tokenYMint;

const seeded = (byte: number) => Keypair.fromSeed(new Uint8Array(32).fill(byte)).publicKey;
export const OWNER = seeded(1).toBase58();
/** Synthetic fee wallet (not the real one); its input-mint ATA exists, as the policy assumes. */
export const FEE_WALLET = seeded(2).toBase58();
export const POSITION = seeded(3).toBase58();
export const BLOCKHASH = seeded(4).toBase58();
export const OWNER_LAMPORTS = 2_000_000_000n;
export const OWNER_TSLA_RAW = 10_000_000n;
export const DEPOSIT_RAW = "1000000";
const TOKEN_ACCOUNT_RENT = 2_039_280;
const PAUSABLE_CONFIG = 26;
const SLOT = capture.slot;

const T22 = TOKEN_2022_PROGRAM_ID;
export const ata = (mint: string, owner: string) => getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true, T22).toBase58();

type Account = AccountInfo<Buffer>;
const account = (owner: string, data: Buffer, lamports = 1_000_000): Account => ({ owner: new PublicKey(owner), data, lamports, executable: false, rentEpoch: 0 });

function tokenAccount(mint: string, owner: string, amount: bigint): Account {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({
    mint: new PublicKey(mint), owner: new PublicKey(owner), amount, delegateOption: 0, delegate: PublicKey.default, state: 1,
    isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default,
  }, data);
  return account(T22.toBase58(), data, TOKEN_ACCOUNT_RENT);
}

/** A PositionV2 account (8120 bytes) for `owner` in `pool` over [lower, lower + width - 1], with `share` in its first bin. */
export function positionAccount(pool: string, owner: string, lower: number, width: number, share = 0n): Account {
  const data = Buffer.alloc(8120);
  Buffer.from(METEORA_POSITION_V2_DISCRIMINATOR, "hex").copy(data, 0);
  new PublicKey(pool).toBuffer().copy(data, 8);
  new PublicKey(owner).toBuffer().copy(data, 40);
  data.writeBigUInt64LE(share, 72);
  data.writeInt32LE(lower, 7912);
  data.writeInt32LE(lower + width - 1, 7916);
  return account(METEORA_DLMM_PROGRAM_ID, data, capture.rentExemptMinimum["8120"]!);
}

/** An empty BinArray account (header + 70 zeroed bins): enough for reads that value a position (all amounts 0). */
function emptyBinArray(pool: string, index: number): Account {
  const data = Buffer.alloc(56 + 70 * 144);
  Buffer.from(BIN_ARRAY_DISCRIMINATOR, "hex").copy(data, 0);
  data.writeBigInt64LE(BigInt(index), 8);
  new PublicKey(pool).toBuffer().copy(data, 24);
  return account(METEORA_DLMM_PROGRAM_ID, data);
}

const encoded = (info: Account | null | undefined) => info
  ? { data: [info.data.toString("base64"), "base64"], owner: info.owner.toBase58(), lamports: info.lamports, executable: false, rentEpoch: 0 }
  : null;

export type FakeChain = ReturnType<typeof createFakeChain>;

/** `autoLand`: a simulated `initialize_position` lands right away (the contract suite walks step 2 straight after 1). */
export function createFakeChain(options: { autoLand?: boolean } = {}) {
  const accounts = new Map<string, Account>();
  for (const pool of Object.entries(capture.pools)) {
    const [address, recorded] = pool;
    accounts.set(address, account(recorded.owner, Buffer.from(recorded.data, "base64")));
    if (recorded.bitmapExtension.exists) accounts.set(recorded.bitmapExtension.address, account(METEORA_DLMM_PROGRAM_ID, Buffer.alloc(8)));
    for (const [index, array] of Object.entries(recorded.binArrays)) if (array.exists) accounts.set(array.address, emptyBinArray(address, Number(index)));
  }
  for (const [mint, recorded] of Object.entries(capture.mints)) accounts.set(mint, account(recorded.owner, Buffer.from(recorded.data, "base64")));
  accounts.set(OWNER, account(SystemProgram.programId.toBase58(), Buffer.alloc(0), Number(OWNER_LAMPORTS)));
  accounts.set(ata(TSLA, OWNER), tokenAccount(TSLA, OWNER, OWNER_TSLA_RAW));
  accounts.set(ata(TSLA, FEE_WALLET), tokenAccount(TSLA, FEE_WALLET, 0n));

  const get = (key: PublicKey) => accounts.get(key.toBase58()) ?? null;
  const simulations: string[] = [];

  /** Applies the Meteora instruction of `tx` to a copy of the state; returns that copy. */
  function execute(tx: VersionedTransaction): Map<string, Account> {
    const next = new Map(accounts);
    const keys = tx.message.staticAccountKeys.map((key) => key.toBase58());
    const payer = keys[0]!;
    for (const ix of tx.message.compiledInstructions) {
      if (keys[ix.programIdIndex] !== METEORA_DLMM_PROGRAM_ID) continue;
      const data = Buffer.from(ix.data);
      const tag = data.subarray(0, 8).toString("hex");
      const at = (index: number) => keys[ix.accountKeyIndexes[index]!]!;
      if (tag === METEORA_IX_DISCRIMINATOR.initializePosition) {
        simulations.push("initialize_position");
        const position = positionAccount(at(2), at(3), data.readInt32LE(8), data.readInt32LE(12));
        next.set(at(1), position);
        const pair = decodeLbPair(next.get(at(2))!.data);
        for (const mint of [pair.tokenXMint, pair.tokenYMint]) if (!next.has(ata(mint, payer))) next.set(ata(mint, payer), tokenAccount(mint, payer, 0n));
        const created = [...next.keys()].filter((key) => !accounts.has(key)).reduce((sum, key) => sum + next.get(key)!.lamports, 0);
        next.set(payer, { ...next.get(payer)!, lamports: next.get(payer)!.lamports - created - 10_000 });
      } else if (tag === METEORA_IX_DISCRIMINATOR.addLiquidityByStrategy2) {
        simulations.push("add_liquidity_by_strategy2");
        const before = next.get(at(0))!;
        const filled = Buffer.from(before.data);
        filled.writeBigUInt64LE(1_000_000n, 72);
        next.set(at(0), { ...before, data: filled });
        const input = ata(TSLA, payer);
        const held = AccountLayout.decode(next.get(input)!.data).amount;
        next.set(input, tokenAccount(TSLA, payer, held - BigInt(DEPOSIT_RAW)));
        next.set(payer, { ...next.get(payer)!, lamports: next.get(payer)!.lamports - 5_000 });
      } else if (tag === METEORA_IX_DISCRIMINATOR.closePosition2) {
        simulations.push("close_position2");
        const position = next.get(at(0))!;
        next.delete(at(0));
        next.set(payer, { ...next.get(payer)!, lamports: next.get(payer)!.lamports + position.lamports - 5_000 });
      }
    }
    return next;
  }

  const connection = {
    async getMultipleAccountsInfoAndContext(keys: PublicKey[]) { return { context: { slot: SLOT }, value: keys.map(get) }; },
    async getMultipleAccountsInfo(keys: PublicKey[]) { return keys.map(get); },
    async getAccountInfo(key: PublicKey) { return get(key); },
    async getAccountInfoAndContext(key: PublicKey) { return { context: { slot: SLOT }, value: get(key) }; },
    async getMinimumBalanceForRentExemption(size: number) {
      if (size === AccountLayout.span) return TOKEN_ACCOUNT_RENT;
      const lamports = capture.rentExemptMinimum[String(size)];
      if (lamports === undefined) throw new Error(`fake chain has no rent for ${size} bytes`);
      return lamports;
    },
    async getLatestBlockhash() { return { blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 }; },
    /** Meteora position heads by discriminator + owner memcmp, with the requested data slice (what listing uses). */
    async getProgramAccounts(program: PublicKey, config?: { dataSlice?: { offset: number; length: number }; filters?: { memcmp: { offset: number; bytes: string } }[] }) {
      const matches = (data: Buffer) => (config?.filters ?? []).every(({ memcmp }) => {
        const want = Buffer.from(bs58.decode(memcmp.bytes));
        return data.subarray(memcmp.offset, memcmp.offset + want.length).equals(want);
      });
      return [...accounts.entries()]
        .filter(([, info]) => info.owner.equals(program) && matches(info.data))
        .map(([address, info]) => ({
          pubkey: new PublicKey(address),
          account: { ...info, data: config?.dataSlice ? info.data.subarray(config.dataSlice.offset, config.dataSlice.offset + config.dataSlice.length) : info.data },
        }));
    },
    async getAddressLookupTable() { return { context: { slot: SLOT }, value: null }; },
    async simulateTransaction(tx: VersionedTransaction, config?: { accounts?: { addresses: string[] } }) {
      const before = simulations.length;
      const next = execute(tx);
      if (options.autoLand && simulations.slice(before).includes("initialize_position")) {
        accounts.clear();
        for (const [key, value] of next) accounts.set(key, value);
      }
      const addresses = config?.accounts?.addresses ?? [];
      return { context: { slot: SLOT }, value: { err: null, logs: [], unitsConsumed: 80_000, accounts: addresses.map((address) => encoded(next.get(address))) } };
    },
  };

  return {
    connection,
    simulations,
    /** Lands what the transaction would do (the wallet signed and sent it). */
    land(tx: VersionedTransaction) {
      const next = execute(tx);
      accounts.clear();
      for (const [key, value] of next) accounts.set(key, value);
    },
    set(address: string, info: Account | null) {
      if (info) accounts.set(address, info); else accounts.delete(address);
    },
    get: (address: string) => accounts.get(address) ?? null,
    /** Sets the recorded Token-2022 PausableConfig of `mint` to paused (TLV entries start at byte 166). */
    pauseMint(mint: string) {
      const info = accounts.get(mint)!;
      const data = Buffer.from(info.data);
      for (let offset = 166; offset + 4 <= data.length;) {
        const type = data.readUInt16LE(offset);
        const length = data.readUInt16LE(offset + 2);
        if (type === PAUSABLE_CONFIG) {
          data[offset + 4 + 32] = 1;
          accounts.set(mint, { ...info, data });
          return;
        }
        offset += 4 + length;
      }
      throw new Error(`${mint} has no PausableConfig extension in the capture`);
    },
  };
}

/**
 * Jupiter replay: an ExactIn quote at a flat 100 out per 1 in (TSLA 6 dp → TSLAx 8 dp), 0.5% slippage, the platform fee
 * Jupiter reports for `platformFeeBps`, and a swap instruction that pays it into `feeAccount` (writable).
 */
export function jupiterReplay(url: string, init?: RequestInit): Response | undefined {
  const parsed = new URL(url);
  if (parsed.host !== JUPITER_API_HOST) return undefined;
  if (parsed.pathname.endsWith("/quote")) {
    const params = parsed.searchParams;
    const amount = BigInt(params.get("amount")!);
    const bps = Number(params.get("platformFeeBps") ?? 0);
    const out = amount * 100n;
    return Response.json({
      inputMint: params.get("inputMint"), outputMint: params.get("outputMint"), inAmount: amount.toString(), outAmount: out.toString(),
      otherAmountThreshold: (out * 9_950n / 10_000n).toString(), swapMode: "ExactIn", slippageBps: Number(params.get("slippageBps")),
      platformFee: bps ? { amount: (amount * BigInt(bps) / 10_000n).toString(), feeBps: bps } : null, priceImpactPct: "0.0001",
      routePlan: [{ percent: 100, swapInfo: { ammKey: TSLA_POOL, label: "Meteora DLMM", inputMint: params.get("inputMint"), outputMint: params.get("outputMint"), inAmount: amount.toString(), outAmount: out.toString() } }],
      contextSlot: SLOT, timeTaken: 0.01,
    });
  }
  if (parsed.pathname.endsWith("/swap-instructions")) {
    const body = JSON.parse(String(init?.body)) as { userPublicKey: string; feeAccount?: string; quoteResponse: { inputMint: string; outputMint: string } };
    const user = body.userPublicKey;
    return Response.json({
      computeBudgetInstructions: [], setupInstructions: [], cleanupInstruction: null, otherInstructions: [], addressLookupTableAddresses: [],
      swapInstruction: {
        programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        accounts: [
          { pubkey: user, isSigner: true, isWritable: true },
          { pubkey: ata(body.quoteResponse.inputMint, user), isSigner: false, isWritable: true },
          { pubkey: ata(body.quoteResponse.outputMint, user), isSigner: false, isWritable: true },
          ...(body.feeAccount ? [{ pubkey: body.feeAccount, isSigner: false, isWritable: true }] : []),
        ],
        data: Buffer.from("e517cb977ae3ad2a", "hex").toString("base64"),
      },
      prioritizationFeeLamports: 0,
    });
  }
  return undefined;
}

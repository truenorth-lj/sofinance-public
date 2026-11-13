import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddressLookupTableProgram, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, type AccountInfo, type Connection } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
vi.mock("./open-state", () => ({ readOpenPoolState: vi.fn() }));
vi.mock("./swap/leg", () => ({ feeSwapLeg: vi.fn() }));
vi.mock("./rpc/fee-estimate", () => ({ estimateFeeForMessage: vi.fn(async () => 5_000), OPEN_FEE_ESTIMATE_MESSAGE: "x" }));
import { readOpenPoolState } from "./open-state";
import { feeSwapLeg } from "./swap/leg";
import { NATIVE_SOL_MINT } from "./ids";
import { swapFeeRecipientAta } from "./swap/fee";
import { buildAndSimulateSolSwapStep, readSolSwapDelivery } from "./sol-swap-step";

const wallet = Keypair.generate().publicKey, other = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey.toBase58();
const feeWallet = Keypair.generate().publicKey;
const feeAta = swapFeeRecipientAta(feeWallet, new PublicKey(NATIVE_SOL_MINT), TOKEN_PROGRAM_ID);
const outputAta = Keypair.generate().publicKey, walletWsol = Keypair.generate().publicKey;
const nativeAta = getAssociatedTokenAddressSync(new PublicKey(NATIVE_SOL_MINT), wallet, false, TOKEN_PROGRAM_ID);
const JUPITER = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SOL = 1_000_000_000;
const RENT = 2_039_280;
const token = (accountIndex: number, owner: PublicKey, amount: string, tokenMint = mint) => ({ accountIndex, mint: tokenMint, owner: owner.toBase58(), uiTokenAmount: { amount, decimals: 9, uiAmount: null, uiAmountString: "" } });
const balance = (owner: PublicKey, amount: string, tokenMint = mint) => token(2, owner, amount, tokenMint);
const feeTokens = (amount: string) => token(1, feeWallet, amount, NATIVE_SOL_MINT);

// Keys of the default step-1 swap; instruction account indexes point into this list.
const KEYS = [wallet, feeAta, outputAta, other, nativeAta, SystemProgram.programId, TOKEN_PROGRAM_ID, JUPITER, ATA_PROGRAM, ComputeBudgetProgram.programId, walletWsol];
const ix = (programIdIndex: number, accountKeyIndexes: number[], data: number[] | Uint8Array) => ({ programIdIndex, accountKeyIndexes, data: Uint8Array.from(data) });
const transfer = (lamports: number, from = 0, to = 4) => {
  const data = new Uint8Array(12); const view = new DataView(data.buffer);
  view.setUint32(0, 2, true); view.setBigUint64(4, BigInt(lamports), true);
  return ix(5, [from, to], data);
};
/** buildForOutput's shape: CU limit, wrap (create, transfer, sync), output ATA, Jupiter swap, close. */
const stepIxs = (wrapped = SOL) => [
  ix(9, [], [2, 0, 0, 0, 0]), ix(8, [0, 4, 0, 6], [1]), transfer(wrapped), ix(6, [4], [17]),
  ix(8, [0, 2, 0, 6], [1]), ix(7, [0, 4, 2, 1], [1, 2, 3]), ix(6, [4, 0, 0], [9]),
];

type Opts = {
  status?: unknown; keys?: PublicKey[]; pre?: unknown[]; post?: unknown[]; err?: unknown; height?: number;
  preBalances?: number[]; postBalances?: number[]; fee?: number; instructions?: ReturnType<typeof ix>[];
};
const balances = (wallet0: number, fee1: number, out2 = RENT, wsol10 = 0) => [wallet0, fee1, out2, 1, 0, 1, 1, 1, 1, 1, wsol10];
/**
 * A legit 1 SOL step-1 swap by default: the wallet spends the wrapped 1 SOL + the 5,000 lamport network fee
 * (its output account already exists), and the fee account gets 10 bps (1,000,000 lamports).
 */
function connection(opts: Opts = {}) {
  const keys = opts.keys ?? KEYS;
  return {
    getSignatureStatuses: vi.fn(async () => ({ value: ["status" in opts ? opts.status : { err: null, confirmationStatus: "confirmed" }] })),
    getBlockHeight: vi.fn(async () => opts.height ?? 0),
    getTransaction: vi.fn(async () => ({
      blockTime: 1_700_000_000, slot: 462_750_173,
      meta: {
        err: opts.err ?? null, loadedAddresses: { writable: [], readonly: [] }, fee: opts.fee ?? 5_000,
        preBalances: opts.preBalances ?? balances(10 * SOL, RENT + 5_000_000),
        postBalances: opts.postBalances ?? balances(9 * SOL - 5_000, RENT + 6_000_000),
        preTokenBalances: opts.pre ?? [balance(wallet, "100"), feeTokens("5000000")],
        postTokenBalances: opts.post ?? [balance(wallet, "24650100"), token(3, other, "5"), feeTokens("6000000")],
      },
      transaction: { message: {
        getAccountKeys: () => ({ length: keys.length, get: (i: number) => keys[i] }),
        compiledInstructions: opts.instructions ?? stepIxs(),
      } },
    })),
  } as unknown as Connection;
}
const read = (conn: Connection, extra: Record<string, unknown> = {}) => readSolSwapDelivery({ signature: "sig", wallet: wallet.toBase58(), outputMint: mint, connection: conn, ...extra });

beforeEach(() => { vi.stubEnv("SOFINANCE_FEE_WALLET", feeWallet.toBase58()); vi.stubEnv("SOFINANCE_FEE_BPS", "10"); });
afterEach(() => vi.unstubAllEnvs());

describe("readSolSwapDelivery", () => {
  it("measures what the swap actually delivered to the wallet (post minus pre)", async () => {
    expect(await read(connection())).toEqual({
      status: "confirmed", delivered: "24650000", decimals: 9, blockTime: 1_700_000_000, slot: 462_750_173,
    });
  });
  it("reports pending, expired and failed without guessing an amount", async () => {
    expect(await read(connection({ status: null }))).toEqual({ status: "pending" });
    expect(await read(connection({ status: null, height: 200 }), { lastValidBlockHeight: 100 })).toEqual({ status: "expired" });
    expect(await read(connection({ status: { err: { x: 1 }, confirmationStatus: "confirmed" } }))).toEqual({ status: "failed" });
    expect(await read(connection({ status: { err: null, confirmationStatus: "processed" } }))).toEqual({ status: "pending" });
    expect(await read(connection({ err: { x: 1 } }))).toEqual({ status: "failed" });
  });
  it("rejects a transaction from another fee payer or one that delivered nothing", async () => {
    await expect(read(connection({ keys: [other, ...KEYS.slice(1)] }))).rejects.toThrow("not paid by this wallet");
    await expect(read(connection({ post: [balance(wallet, "100")] }))).rejects.toThrow("did not deliver");
    await expect(read(connection({ post: [balance(wallet, "999", Keypair.generate().publicKey.toBase58())] }))).rejects.toThrow("did not deliver");
  });
});

describe("buildAndSimulateSolSwapStep", () => {
  const key = () => Keypair.generate().publicKey;
  const outputMint = key(), otherMint = key(), poolId = key();
  const outputAta = getAssociatedTokenAddressSync(outputMint, wallet, false, TOKEN_PROGRAM_ID);
  const nativeAta = getAssociatedTokenAddressSync(new PublicKey(NATIVE_SOL_MINT), wallet, false, TOKEN_PROGRAM_ID);
  const SOL = 10_000_000_000n;
  const info = (data: Buffer, owner: PublicKey): AccountInfo<Buffer> => ({ data, owner, executable: false, lamports: 2_039_280, rentEpoch: 0 });
  const tokenAccount = (tokenMint: PublicKey, owner: PublicKey, amount: bigint) => {
    const data = Buffer.alloc(165); tokenMint.toBuffer().copy(data); owner.toBuffer().copy(data, 32);
    data.writeBigUInt64LE(amount, 64); data[108] = 1; return data;
  };
  const lookupTable = (addresses: PublicKey[]) => {
    const data = Buffer.alloc(56 + 32 * addresses.length);
    data.writeUInt32LE(1, 0); data.writeBigUInt64LE(2n ** 64n - 1n, 4);
    addresses.forEach((address, index) => address.toBuffer().copy(data, 56 + 32 * index));
    return info(data, AddressLookupTableProgram.programId);
  };
  const accounts = new Map<string, AccountInfo<Buffer>>();
  const swapConnection = {
    getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map((k) => accounts.get(k.toBase58()) ?? null)),
    getMultipleAccountsInfoAndContext: vi.fn(async (keys: PublicKey[]) => ({ context: { slot: 1 }, value: keys.map((k) => accounts.get(k.toBase58()) ?? null) })),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: key().toBase58(), lastValidBlockHeight: 999 })),
    simulateTransaction: vi.fn(async () => ({ context: { slot: 2 }, value: { err: null, unitsConsumed: 90_000, accounts: [
      { data: ["", "base64"], owner: SystemProgram.programId.toBase58(), lamports: Number(SOL - 1_000_000_000n - 2_039_280n - 5_000n), executable: false },
      { data: [tokenAccount(outputMint, wallet, 1_000_000n).toString("base64"), "base64"], owner: TOKEN_PROGRAM_ID.toBase58(), lamports: 2_039_280, executable: false },
    ] } })),
  } as unknown as Connection;

  beforeEach(() => {
    accounts.clear();
    vi.mocked(readOpenPoolState).mockResolvedValue({
      poolId: poolId.toBase58(), mintA: outputMint.toBase58(), mintB: otherMint.toBase58(),
      ataA: outputAta.toBase58(), ataB: getAssociatedTokenAddressSync(otherMint, wallet, false, TOKEN_PROGRAM_ID).toBase58(),
      programA: TOKEN_PROGRAM_ID.toBase58(), programB: TOKEN_PROGRAM_ID.toBase58(), decimalsA: 6, decimalsB: 6, symbolA: "OUT", symbolB: "OTHER",
      balances: { a: "0", b: "0" }, inputBalance: SOL.toString(), solLamports: SOL.toString(),
      paused: false, frozen: false, transferFee: false, unsupportedExtensions: [],
    } as never);
  });

  it("keeps the compact lookup tables in the restamped transaction, so a route that fit still fits", async () => {
    // Table A covers ten route keys; table B covers one, which costs more as a lookup than inline. The compact compile
    // drops B. Re-stamping with every route table would put B back (+3 bytes): 1,231 -> 1,234 bytes, over the limit.
    const extra = Array.from({ length: 11 }, () => key());
    const tableA = key(), tableB = key();
    accounts.set(tableA.toBase58(), lookupTable(extra.slice(0, 10)));
    accounts.set(tableB.toBase58(), lookupTable(extra.slice(10)));
    let dataBytes = 0;
    let withTableB = false;
    vi.mocked(feeSwapLeg).mockImplementation(async (input) => ({
      inputMint: input.inputMint, outputMint: input.outputMint, spend: input.spend,
      feeAmount: input.spend * 10n / 10_000n, feeInRoute: true, minOut: 900_000n,
      route: {
        outAmount: "1000000", setupInstructions: [], cleanupInstruction: null, otherInstructions: [],
        addressesByLookupTableAddress: { [tableA.toBase58()]: extra.slice(0, 10).map(String),
          ...(withTableB ? { [tableB.toBase58()]: [extra[10]!.toBase58()] } : {}) },
        swapInstruction: { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", data: Buffer.alloc(dataBytes).toString("base64"), accounts: [
          { pubkey: wallet.toBase58(), isSigner: true, isWritable: true },
          { pubkey: nativeAta.toBase58(), isSigner: false, isWritable: true },
          { pubkey: outputAta.toBase58(), isSigner: false, isWritable: true },
          { pubkey: feeAta.toBase58(), isSigner: false, isWritable: true },
          ...extra.map((pubkey) => ({ pubkey: pubkey.toBase58(), isSigner: false, isWritable: false })),
        ] },
      },
    }) as never);
    const build = () => buildAndSimulateSolSwapStep(wallet.toBase58(), poolId.toBase58(), "1", { connection: swapConnection });
    // With table A only, pad the swap data so the transaction is 1 byte under the 1,232-byte limit (second pass: the
    // data length prefix grows). Then the route also returns table B, which the compact compile leaves out.
    for (let pass = 0; pass < 2; pass++) dataBytes += 1_231 - (await build()).summary.sizeBytes;
    withTableB = true;
    const { summary, transaction } = await build();
    expect(summary.sizeBytes).toBe(1_231);
    expect(transaction.message.addressTableLookups.map((lookup) => lookup.accountKey.toBase58())).toEqual([tableA.toBase58()]);
    // The shipped limit is still the measured one (90,000 consumed -> 140,000), not the 1.4M simulation ceiling.
    const budget = ComputeBudgetProgram.programId.toBase58();
    const limit = transaction.message.compiledInstructions.find((ix) =>
      transaction.message.staticAccountKeys[ix.programIdIndex]!.toBase58() === budget && ix.data[0] === 2);
    expect(Buffer.from(limit!.data).readUInt32LE(1)).toBe(140_000);
  });
});

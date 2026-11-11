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
import { buildAndSimulateSolSwapStep, isSolSwapCreditSpent, readSolSwapDelivery, SOL_SWAP_SPENT_SCAN_LIMIT, solSwapStepWrappedLamports } from "./sol-swap-step";

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
const feeCheck = async (opts: Opts) => {
  const result = (await read(connection(opts))) as { feeAccountPaid?: boolean; feeCheck?: string };
  expect(result.feeAccountPaid).toBe(result.feeCheck === "ok");
  return result.feeCheck;
};

beforeEach(() => { vi.stubEnv("SOFINANCE_FEE_WALLET", feeWallet.toBase58()); vi.stubEnv("SOFINANCE_FEE_BPS", "10"); });
afterEach(() => vi.unstubAllEnvs());

describe("readSolSwapDelivery", () => {
  it("measures what the swap actually delivered to the wallet (post minus pre) and where it landed", async () => {
    expect(await read(connection())).toEqual({
      status: "confirmed", delivered: "24650000", decimals: 9, blockTime: 1_700_000_000, feeAccountPaid: true, feeCheck: "ok", slot: 462_750_173,
      outputAccounts: [outputAta.toBase58()],
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

describe("readSolSwapDelivery protocol fee check (feeCheck / feeAccountPaid)", () => {
  const delivered = [balance(wallet, "24650100")];

  it("accepts the server-built shape with wallet-added compute budget, Lighthouse and memo instructions", async () => {
    const lighthouse = new PublicKey("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
    expect(await feeCheck({ keys: [...KEYS, lighthouse], instructions: [ix(9, [], [3, 1]), ...stepIxs(), ix(11, [0], [7])] })).toBe("ok");
  });
  it("rejects a missing or short fee", async () => {
    expect(await feeCheck({ keys: [wallet, other, ...KEYS.slice(2)] })).toBe("fee_short");
    expect(await feeCheck({ post: [...delivered, feeTokens("5000000")] })).toBe("fee_short");
    expect(await feeCheck({ post: [...delivered, feeTokens("5500000")] })).toBe("fee_short");
  });
  it("treats an existing fee account with no pre-transaction balance as unmeasured (not covered)", async () => {
    expect(await feeCheck({ pre: [balance(wallet, "100")] })).toBe("fee_short");
    // A fee account created in this transaction (no lamports before) is measured from 0.
    expect(await feeCheck({ pre: [balance(wallet, "100")], post: [...delivered, feeTokens("1000000")],
      preBalances: balances(10 * SOL, 0), postBalances: balances(9 * SOL - 5_000, RENT + 1_000_000) })).toBe("ok");
  });
  it("allows only 1 lamport + 1% of the fee due as rounding slack (10,001 lamports on 1 SOL)", async () => {
    expect(await feeCheck({ post: [...delivered, feeTokens(String(6_000_000 - 10_001))] })).toBe("ok");
    expect(await feeCheck({ post: [...delivered, feeTokens(String(6_000_000 - 10_002))] })).toBe("fee_short");
  });
  it("keeps the slack relative on a small swap: 0.01 SOL owes 10,000 lamports and may be short by 101 at most", async () => {
    const small = (paid: number) => ({ instructions: stepIxs(10_000_000), post: [...delivered, feeTokens(String(5_000_000 + paid))],
      postBalances: balances(10 * SOL - 10_000_000 - 5_000, RENT + 5_000_000 + paid) });
    expect(await feeCheck(small(10_000 - 101))).toBe("ok");
    expect(await feeCheck(small(10_000 - 102))).toBe("fee_short");
    expect(await feeCheck(small(2_500))).toBe("fee_short");
  });
  it("rejects a dust swap whose 10 bps rounds to zero, even with a lamport paid to the fee account", async () => {
    expect(await feeCheck({ instructions: stepIxs(999), post: [...delivered, feeTokens("5000001")],
      postBalances: balances(10 * SOL - 999 - 5_000, RENT + 5_000_001) })).toBe("fee_short");
  });
  it("rejects a non-SOL swap (e.g. USDC -> stock) that sends a lamport of wSOL to the fee account", async () => {
    const usdc = Keypair.generate().publicKey.toBase58();
    // No wrap at all: just a Jupiter swap spending USDC.
    expect(await feeCheck({ instructions: [ix(7, [0, 1, 2], [1])], pre: [balance(wallet, "100"), feeTokens("5000000"), token(10, wallet, "50000000", usdc)],
      post: [...delivered, feeTokens("5000001"), token(10, wallet, "0", usdc)], postBalances: balances(10 * SOL - 5_000, RENT + 5_000_001) })).toBe("not_sol_swap");
    // A real 1 SOL wrap and fee, but the swap also spends the wallet's USDC.
    expect(await feeCheck({ pre: [balance(wallet, "100"), feeTokens("5000000"), token(10, wallet, "50000000", usdc)],
      post: [...delivered, feeTokens("6000000"), token(10, wallet, "0", usdc)] })).toBe("not_sol_swap");
  });
  it("rejects an inflated delivery: a small real swap plus tokens transferred in by another instruction", async () => {
    const tokenTransferIn = ix(6, [3, 2, 3], [3, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(await feeCheck({ instructions: [...stepIxs(), tokenTransferIn] })).toBe("not_sol_swap");
    // A second swap, a SOL transfer elsewhere, or an unknown program are refused the same way.
    expect(await feeCheck({ instructions: [...stepIxs(), ix(7, [0], [1])] })).toBe("not_sol_swap");
    expect(await feeCheck({ instructions: [...stepIxs(), transfer(5, 0, 3)] })).toBe("not_sol_swap");
    expect(await feeCheck({ keys: [...KEYS, other], instructions: [...stepIxs(), ix(11, [0], [1])] })).toBe("not_sol_swap");
  });
  it("rejects swapping wSOL the wallet already held beyond the wrapped amount (+0.01 SOL)", async () => {
    // Wraps 1 SOL but also swaps 50 SOL of held wSOL (account 10, left open).
    const wsol = (amount: string) => token(10, wallet, amount, NATIVE_SOL_MINT);
    expect(await feeCheck({
      preBalances: balances(10 * SOL, RENT + 5_000_000, RENT, RENT + 50 * SOL), postBalances: balances(9 * SOL - 5_000, RENT + 6_000_000, RENT, RENT),
      pre: [balance(wallet, "100"), feeTokens("5000000"), wsol(String(50 * SOL))], post: [...delivered, feeTokens("6000000"), wsol("0")],
    })).toBe("not_sol_swap");
  });
  it("does not count the rent of a new output token account as swapped SOL", async () => {
    expect(await feeCheck({
      preBalances: balances(10 * SOL, RENT + 5_000_000, 0), postBalances: balances(9 * SOL - 5_000 - RENT, RENT + 6_000_000, RENT),
      pre: [feeTokens("5000000")], post: [balance(wallet, "24650000"), feeTokens("6000000")],
    })).toBe("ok");
  });
  it("is satisfied when no fee is configured", async () => {
    vi.stubEnv("SOFINANCE_FEE_BPS", "0");
    expect(await feeCheck({ post: delivered })).toBe("ok");
    vi.stubEnv("SOFINANCE_FEE_BPS", "10"); vi.stubEnv("SOFINANCE_FEE_WALLET", "");
    expect(await feeCheck({ post: delivered })).toBe("ok");
  });
});

describe("solSwapStepWrappedLamports", () => {
  const keyAt = (index: number) => KEYS[index]?.toBase58();
  it("returns the wrapped lamports for the server-built shape and null otherwise", () => {
    expect(solSwapStepWrappedLamports(stepIxs(), keyAt, wallet.toBase58())).toBe(BigInt(SOL));
    expect(solSwapStepWrappedLamports(stepIxs().filter((item) => item.programIdIndex !== 7), keyAt, wallet.toBase58())).toBeNull();
    expect(solSwapStepWrappedLamports(stepIxs().filter((item) => item.programIdIndex !== 5), keyAt, wallet.toBase58())).toBeNull();
  });
});

describe("isSolSwapCreditSpent", () => {
  const owner = wallet.toBase58();
  type Later = { signature: string; err: unknown };
  const chain = (later: Later[], txs: Record<string, unknown> = {}) => ({
    getSignaturesForAddress: vi.fn(async () => later),
    getTransaction: vi.fn(async (signature: string) => txs[signature] ?? null),
  }) as unknown as Connection;
  const moved = (pre: string, post: string, err: unknown = null) => ({ meta: { err, preTokenBalances: [balance(wallet, pre)], postTokenBalances: [balance(wallet, post)] } });
  const spent = (conn: Connection, outputAccounts = [outputAta.toBase58()]) =>
    isSolSwapCreditSpent({ signature: "swap", wallet: owner, outputMint: mint, outputAccounts, connection: conn });

  it("is unspent when nothing touched the output account after the swap, and asks only for later transactions", async () => {
    const conn = chain([]);
    await expect(spent(conn)).resolves.toBe(false);
    expect(conn.getSignaturesForAddress).toHaveBeenCalledWith(outputAta, { until: "swap", limit: SOL_SWAP_SPENT_SCAN_LIMIT }, "confirmed");
  });
  it("stays unspent after a failed open or one that only added tokens (a step 2/2 retry is allowed)", async () => {
    await expect(spent(chain([{ signature: "failed", err: { x: 1 } }]))).resolves.toBe(false);
    await expect(spent(chain([{ signature: "in", err: null }], { in: moved("100", "200") }))).resolves.toBe(false);
    await expect(spent(chain([{ signature: "metaErr", err: null }], { metaErr: moved("100", "0", { x: 1 }) }))).resolves.toBe(false);
  });
  it("is spent (reused) once a later successful transaction moved the delivered tokens out", async () => {
    await expect(spent(chain([{ signature: "open", err: null }], { open: moved("24650100", "100") }))).resolves.toBe(true);
  });
  it("counts an unreadable or very busy history, or no known output account, as spent", async () => {
    await expect(spent(chain([{ signature: "unknown", err: null }]))).resolves.toBe(true);
    await expect(spent(chain(Array.from({ length: SOL_SWAP_SPENT_SCAN_LIMIT }, (_, i) => ({ signature: `s${i}`, err: { x: 1 } }))))).resolves.toBe(true);
    await expect(spent(chain([]), [])).resolves.toBe(true);
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
    // Step 2's fee check recognises the transaction this builder ships, with the wrapped amount as its input.
    const keyAt = (index: number) => transaction.message.staticAccountKeys[index]?.toBase58();
    expect(solSwapStepWrappedLamports(transaction.message.compiledInstructions, keyAt, wallet.toBase58())).toBe(1_000_000_000n);
  });
});

import { AddressLookupTableAccount, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import oldFixture from "./fixtures/open-size-route.json";
import compactFixture from "./fixtures/open-size-compact-route.json";
vi.mock("./rpc", () => ({ rpcConnection: vi.fn() }));
vi.mock("./open-state", () => ({ readOpenPoolState: vi.fn() }));
vi.mock("./open-quote", () => ({ getOpenPositionQuoteBundle: vi.fn() }));
vi.mock("./open-simulation", () => ({ simulateAndVerifyOpenTransaction: vi.fn() }));
vi.mock("./open-transaction", async importOriginal => ({ ...await importOriginal<object>(), openLookupTableReader: vi.fn() }));
vi.mock("./solami-beam", async importOriginal => ({
  ...await importOriginal<object>(),
  fetchBeamTipAddress: vi.fn(async () => null),
}));
vi.mock("@raydium-io/raydium-sdk-v2", async importOriginal => ({ ...await importOriginal<object>(),
  Raydium: { load: vi.fn() }, ClmmInstrument: { openPositionFromLiquidityInstructions: vi.fn() },
}));
import { Raydium, ClmmInstrument } from "@raydium-io/raydium-sdk-v2";
import { rpcConnection } from "./rpc";
import { readOpenPoolState } from "./open-state";
import { getOpenPositionQuoteBundle } from "./open-quote";
import { simulateAndVerifyOpenTransaction } from "./open-simulation";
import { openLookupTableReader } from "./open-transaction";
import { fetchBeamTipAddress } from "./solami-beam";
import { buildAndSimulateOpenPosition } from "./open-atomic";
import { TargetPoolProjectionError } from "./target-pool-projection";

const decode = (f: typeof oldFixture) => ({
  ixs: f.instructions.map(ix => new TransactionInstruction({ programId: new PublicKey(ix.program), data: Buffer.from(ix.data, "base64"),
    keys: ix.accounts.map(([address, flags]) => ({ pubkey: new PublicKey(address as string), isSigner: Boolean((flags as number) & 1), isWritable: Boolean((flags as number) & 2) })) })),
  tables: f.tables.map(table => new AddressLookupTableAccount({ key: new PublicKey(table.key), state: {
    deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: Array.from({ length: table.length }, (_, index) => new PublicKey(
      table.entries.find(entry => entry[0] === index)?.[1] as string ?? PublicKey.default.toBase58())),
  } })),
});
const old = decode(oldFixture), compact = decode(compactFixture);
const wallet = compactFixture.payer, inputMint = "So11111111111111111111111111111111111111112";
const mintA = compact.ixs[4]!.keys[3]!.pubkey.toBase58(), mintB = compact.ixs[5]!.keys[3]!.pubkey.toBase58();
const poolId = Keypair.generate().publicKey.toBase58();
let strategy: string;
const state = { wallet, poolId, programId: compact.ixs[8]!.programId.toBase58(), mintA, mintB,
  ataA: compact.ixs[4]!.keys[1]!.pubkey.toBase58(), ataB: compact.ixs[5]!.keys[1]!.pubkey.toBase58(),
  programA: compact.ixs[4]!.keys[5]!.pubkey.toBase58(), programB: compact.ixs[5]!.keys[5]!.pubkey.toBase58(),
  inputMint, inputKind: "native", tickSpacing: 1, solLamports: 1000000000, balances: { a: "0", b: "0", input: "0" } };

afterEach(() => { vi.unstubAllEnvs(); });
beforeEach(() => {
  // Hermetic: ambient fee/key env must not change prepared-transaction contents.
  vi.stubEnv("SOFINANCE_FEE_WALLET", undefined); vi.stubEnv("SOFINANCE_FEE_BPS", undefined); vi.stubEnv("JUPITER_API_KEY", undefined);
  vi.clearAllMocks(); strategy = "parallel";
  vi.mocked(rpcConnection).mockReturnValue({
    getMultipleAccountsInfoAndContext: vi.fn(async (keys: PublicKey[]) => ({ context: { slot: 1 }, value: keys.map(() => null) })),
    getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map(() => null)),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: oldFixture.blockhash, lastValidBlockHeight: 100 })),
    getFeeForMessage: vi.fn(async () => ({ value: 10000 })),
  } as never);
  vi.mocked(readOpenPoolState).mockResolvedValue({ ...state, fetchedAt: Date.now() } as never);
  vi.mocked(Raydium.load).mockResolvedValue({ clmm: { getPoolInfoFromRpc: vi.fn(async () => ({
    poolInfo: { programId: state.programId, mintA: { address: mintA }, mintB: { address: mintB }, config: { tickSpacing: 1 } }, poolKeys: {},
  })) }, api: { fetchPoolKeysById: vi.fn(async () => []) } } as never);
  vi.mocked(openLookupTableReader).mockImplementation(() => async keys => {
    const tables = strategy === "sequential" ? compact.tables : old.tables;
    return keys.map(key => tables.find(table => table.key.equals(key))!);
  });
  vi.mocked(ClmmInstrument.openPositionFromLiquidityInstructions).mockImplementation(async () => ({
    instructions: [strategy === "sequential" ? compact.ixs[8]! : old.ixs[17]!], lookupTableAddress: [],
    signers: [Keypair.fromSeed(new Uint8Array(32).fill(8))],
  } as never));
  vi.mocked(getOpenPositionQuoteBundle).mockImplementation(async (_wallet, _selection, _amount, _range, _floor, _tolerance, _budget, _snapshot, mode) => {
    strategy = mode === "parallel" ? "parallel" : "sequential";
    const sequential = mode !== "parallel";
    const primaryMint = mode === "sequential-b" ? mintB : mintA;
    const secondaryMint = mode === "sequential-b" ? mintA : mintB;
    const captured = sequential ? compact : old;
    const route = (ix: TransactionInstruction, input: string, output: string, spend: bigint, minOut: bigint, setup: TransactionInstruction[] = []) => ({
      inputMint: input, outputMint: output, spend, minOut,
      route: { inputMint: input, outputMint: output, inAmount: spend.toString(), otherAmountThreshold: "3000000",
        setupInstructions: setup.map(apiInstruction), swapInstruction: apiInstruction(ix), cleanupInstruction: null, otherInstructions: [],
        addressesByLookupTableAddress: Object.fromEntries(captured.tables.map(table => [table.key.toBase58(), table.state.addresses.map(key => key.toBase58())])),
      },
    });
    return { state, quote: { expiresAt: Date.now() + 75000, requested: "30000000", rangeSide: "inside", tickLower: -60, tickUpper: 60,
      liquidity: "10000", amountMaxA: "10000", amountMaxB: "10000", passesFloor: true, warning: "",
      rent: { refundableLamports: "0", nonRefundableLamports: "0" } },
      legs: sequential
        ? [route(compact.ixs[6]!, inputMint, primaryMint, 30000000n, 1500000n), route(compact.ixs[7]!, primaryMint, secondaryMint, 1500000n, 10000n)]
        : [route(old.ixs[6]!, inputMint, mintA, 15000000n, 10000n, old.ixs.slice(4, 6)), route(old.ixs[13]!, inputMint, mintB, 15000000n, 10000n, old.ixs.slice(11, 13))],
    } as never;
  });
  vi.mocked(simulateAndVerifyOpenTransaction).mockResolvedValue({ endingLiquidity: "10000", spentInput: null, dustA: "0", dustB: "0",
    solDebitLamports: "30010000", positionAccount: poolId, nftAta: poolId, unitsConsumed: 350000 });
});
function apiInstruction(ix: TransactionInstruction) {
  return { programId: ix.programId.toBase58(), data: ix.data.toString("base64"),
    accounts: ix.keys.map(key => ({ pubkey: key.pubkey.toBase58(), isSigner: key.isSigner, isWritable: key.isWritable })) };
}
const prepare = () => buildAndSimulateOpenPosition(wallet, { poolId, inputMint, inputKind: "native" }, "0.03", { preset: "standard" }, 9900, 100);

function oversized(bundle: Awaited<ReturnType<typeof getOpenPositionQuoteBundle>>) {
  for (const leg of bundle.legs) if (leg.route) {
    leg.route.swapInstruction.data = Buffer.concat([Buffer.from(leg.route.swapInstruction.data, "base64"), Buffer.alloc(300)]).toString("base64");
  }
  return bundle;
}

it("prepares the compact captured sequential transaction first", async () => {
  const { summary, transaction } = await prepare();
  expect(getOpenPositionQuoteBundle).toHaveBeenCalledTimes(1);
  expect(vi.mocked(getOpenPositionQuoteBundle).mock.calls.map(call => [call[6], call[8]])).toEqual([
    [{ maxAccounts: 20 }, "sequential-b"],
  ]);
  expect(readOpenPoolState).toHaveBeenCalledTimes(1);
  expect(Raydium.load).toHaveBeenCalledTimes(1);
  expect(simulateAndVerifyOpenTransaction).toHaveBeenCalledTimes(1);
  expect(summary.sizeBytes).toBeLessThanOrEqual(1232);
  expect(summary.sizeBytes).toBe(transaction.serialize().length);
  expect(Buffer.from(transaction.serialize()).toString("base64")).toMatchSnapshot();
  expect(transaction.signatures[0]!.every(byte => byte === 0)).toBe(true);
  expect(transaction.signatures[1]!.some(byte => byte !== 0)).toBe(true);
});
it("enforces the resale floor for agent/MCP prepares unless the caller disables it", async () => {
  vi.mocked(getOpenPositionQuoteBundle).mockResolvedValue({
    state, quote: { expiresAt: Date.now() + 75000, requested: "30000000", rangeSide: "inside",
      passesFloor: false, warning: "Conservative immediate resale is 90.00% of input",
      rent: { refundableLamports: "0", nonRefundableLamports: "0" } },
    legs: [],
  } as never);
  await expect(prepare()).rejects.toThrow(/resale/i);
  await expect(buildAndSimulateOpenPosition(wallet, { poolId, inputMint, inputKind: "native" }, "0.03",
    { preset: "standard" }, 9900, 100, { enforceResaleFloor: false }))
    .rejects.toThrow(/Swap route does not match/);
});

it("stops on quote safety failures instead of retrying with relaxed guards", async () => {
  vi.mocked(getOpenPositionQuoteBundle).mockRejectedValue(new Error("Price impact exceeds 5% limit"));
  await expect(prepare()).rejects.toThrow("Price impact");
  expect(getOpenPositionQuoteBundle).toHaveBeenCalledTimes(1);
  expect(simulateAndVerifyOpenTransaction).not.toHaveBeenCalled();
});
it("falls back to the next strategy when a hop through the target pool would move its price out of range", async () => {
  // Sequential strategies route the pool-token hop through the target pool itself; on a thin pool with a
  // narrow range that hop alone can cross the range edge, while other legs (e.g. the parallel ones that
  // /open-quote priced) never touch the pool. The same guard runs on every attempt, so moving on relaxes nothing.
  const quoteBundle = vi.mocked(getOpenPositionQuoteBundle).getMockImplementation()!;
  vi.mocked(getOpenPositionQuoteBundle).mockImplementation(async (...args) => {
    if (args[8] === "sequential-b") {
      throw new TargetPoolProjectionError("Swap may cause target pool price to cross the selected range, please re-quote");
    }
    return quoteBundle(...args);
  });
  const { summary } = await prepare();
  expect(vi.mocked(getOpenPositionQuoteBundle).mock.calls.map(call => [call[6], call[8]])).toEqual([
    [{ maxAccounts: 20 }, "sequential-b"],
    [{ maxAccounts: 20 }, "sequential"],
  ]);
  expect(summary.sizeBytes).toBeLessThanOrEqual(1232);
  expect(simulateAndVerifyOpenTransaction).toHaveBeenCalledTimes(1);
});

it("surfaces the target-pool projection error when every strategy would move the pool out of range", async () => {
  vi.mocked(getOpenPositionQuoteBundle).mockRejectedValue(
    new TargetPoolProjectionError("Swap may cause target pool price to cross the selected range, please re-quote"));
  await expect(prepare()).rejects.toThrow("cross the selected range");
  // Every attempt, parallel included, was tried and guarded before giving up.
  expect(getOpenPositionQuoteBundle).toHaveBeenCalledTimes(9);
  expect(vi.mocked(getOpenPositionQuoteBundle).mock.calls.filter(call => call[8] === "parallel")).toHaveLength(3);
  expect(simulateAndVerifyOpenTransaction).not.toHaveBeenCalled();
});

it("does not return a prepared transaction after simulation fails", async () => {
  vi.mocked(simulateAndVerifyOpenTransaction).mockRejectedValue(new Error("Simulated input asset expenditure exceeds limit"));
  await expect(prepare()).rejects.toThrow("expenditure");
  expect(simulateAndVerifyOpenTransaction).toHaveBeenCalledTimes(1);
});

it("tries the other swap direction when the first swap + open route exceeds the packet limit", async () => {
  const quoteBundle = vi.mocked(getOpenPositionQuoteBundle).getMockImplementation()!;
  vi.mocked(getOpenPositionQuoteBundle).mockImplementation(async (...args) => {
    const constraints = args[6] as { maxAccounts: number };
    const bundle = await quoteBundle(...args);
    return constraints.maxAccounts <= 20 && args[8] === "sequential" ? bundle : oversized(bundle);
  });
  const { summary } = await prepare();
  expect(summary.sizeBytes).toBeLessThanOrEqual(1232);
  expect(simulateAndVerifyOpenTransaction).toHaveBeenCalledTimes(1);
});

it("rejects oversized candidates before looking up optional Beam tips", async () => {
  const quoteBundle = vi.mocked(getOpenPositionQuoteBundle).getMockImplementation()!;
  vi.mocked(getOpenPositionQuoteBundle).mockImplementation(async (...args) => {
    return oversized(await quoteBundle(...args));
  });
  await expect(prepare()).rejects.toThrow(/exceeds 1,232 byte limit/);
  expect(fetchBeamTipAddress).not.toHaveBeenCalled();
  expect(simulateAndVerifyOpenTransaction).not.toHaveBeenCalled();
});

it("budgets newly created pool token accounts in the simulation SOL limit", async () => {
  const quoteBundle = vi.mocked(getOpenPositionQuoteBundle).getMockImplementation()!;
  vi.mocked(getOpenPositionQuoteBundle).mockImplementation(async (...args) => {
    const bundle = await quoteBundle(...args);
    bundle.quote.rent.walletTokenAccountLamports = "4155120";
    return bundle;
  });
  const { summary } = await prepare();
  expect(summary.maxSolDebitLamports).toBe("34265120");
  expect(summary.rentLamports).toBe(4155120);
});

describe("fee payer separation (sponsored mode)", () => {
  const sponsor = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58();
  const tokenState = () => ({ ...state, inputKind: "token", inputAccount: Keypair.fromSeed(new Uint8Array(32).fill(4)).publicKey.toBase58(),
    inputTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", inputDecimals: 9, solLamports: 0, fetchedAt: Date.now() });

  it("owner mode: feePayer equal to the wallet yields byte-identical transactions", async () => {
    const plain = await prepare();
    const same = await buildAndSimulateOpenPosition(wallet, { poolId, inputMint, inputKind: "native" }, "0.03", { preset: "standard" }, 9900, 100, { feePayer: wallet });
    expect(Buffer.from(same.transaction.serialize()).equals(Buffer.from(plain.transaction.serialize()))).toBe(true);
    const stable = (summary: object) => JSON.parse(JSON.stringify(summary, (key, value) => /At$/.test(key) ? undefined : value));
    expect(stable(same.summary as never)).toEqual(stable(plain.summary as never));
  });

  it("uses an injected connection instead of the host default", async () => {
    const injected = vi.mocked(rpcConnection).getMockImplementation()?.() ?? vi.mocked(rpcConnection)();
    vi.mocked(rpcConnection).mockClear();
    await buildAndSimulateOpenPosition(wallet, { poolId, inputMint, inputKind: "native" }, "0.03", { preset: "standard" }, 9900, 100, { connection: injected as never });
    expect(rpcConnection).not.toHaveBeenCalled();
  });

  it("rejects native SOL input (the wallet would have to fund the wrap)", async () => {
    await expect(buildAndSimulateOpenPosition(wallet, { poolId, inputMint, inputKind: "native" }, "0.03", { preset: "standard" }, 9900, 100, { feePayer: sponsor }))
      .rejects.toThrow("Sponsored open-position does not accept native SOL input");
  });

  it("makes the sponsor the message payer and Raydium rent payer, never asks the wallet for SOL, and skips Beam", async () => {
    vi.mocked(readOpenPoolState).mockResolvedValue(tokenState() as never);
    const quoteBundle = vi.mocked(getOpenPositionQuoteBundle).getMockImplementation()!;
    vi.mocked(getOpenPositionQuoteBundle).mockImplementation(async (...args) => ({ ...await quoteBundle(...args), state: tokenState() } as never));
    let result: Awaited<ReturnType<typeof prepare>> | undefined;
    let sizeError: unknown;
    try {
      result = await buildAndSimulateOpenPosition(wallet, { poolId, inputMint, inputKind: "token" }, "0.03", { preset: "standard" }, 9900, 100, { feePayer: sponsor });
    } catch (error) { sizeError = error; }
    expect(fetchBeamTipAddress).not.toHaveBeenCalled();
    expect(sizeError).toBeUndefined();
    const { transaction, summary } = result!;
    const open = transaction.message.compiledInstructions.find(ix => transaction.message.staticAccountKeys[ix.programIdIndex]!.toBase58() === state.programId)!;
    expect(transaction.message.staticAccountKeys[open.accountKeyIndexes[0]!]!.toBase58()).toBe(sponsor);
    expect(transaction.message.staticAccountKeys[open.accountKeyIndexes[1]!]!.toBase58()).toBe(wallet);
    const keys = transaction.message.staticAccountKeys.map(key => key.toBase58());
    expect(transaction.message.header.numRequiredSignatures).toBe(3);
    expect(keys[0]).toBe(sponsor);
    expect(keys.slice(0, 3)).toContain(wallet);
    expect(summary.maxSolDebitLamports).toBe("0");
    expect(vi.mocked(simulateAndVerifyOpenTransaction).mock.calls[0]![0]).toMatchObject({ maxSolDebitLamports: 0n, minRemainingSolLamports: 0n });
  });
});

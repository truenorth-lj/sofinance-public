import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
vi.mock("server-only", () => ({}));
vi.mock("./rpc", () => ({ rpcConnection: vi.fn() }));
vi.mock("./selected-state", () => ({ readSelectedPositionState: vi.fn() }));
vi.mock("./selected-quote", () => ({ getSelectedQuoteBundle: vi.fn() }));
vi.mock("./selected-simulation", () => ({ simulateAndVerifySelectedTransaction: vi.fn() }));
vi.mock("./selected-add-instruction", () => ({ buildSelectedAddInstruction: vi.fn() }));
vi.mock("./transaction-helpers", async (original) => ({ ...await original<typeof import("./transaction-helpers")>(), readLookupTables: vi.fn(async () => []) }));
vi.mock("./solami-beam", async (original) => ({ ...await original<typeof import("./solami-beam")>(), fetchBeamTipAddress: vi.fn(async () => null) }));
import { rpcConnection } from "./rpc";
import { readSelectedPositionState } from "./selected-state";
import { getSelectedQuoteBundle } from "./selected-quote";
import { buildSelectedAddInstruction } from "./selected-add-instruction";
import { simulateAndVerifySelectedTransaction } from "./selected-simulation";
import { fetchBeamTipAddress } from "./solami-beam";
import { buildAndSimulateSelectedZap } from "./selected-atomic";
let keyIndex = 1;
const key = () => Keypair.fromSeed(new Uint8Array(32).fill(keyIndex++)).publicKey;
const wallet = key(), pool = key(), position = key(), program = key(), mintA = key(), mintB = key();
const state = { positionMint: key().toBase58(), positionAccount: position.toBase58(), poolId: pool.toBase58(), programId: program.toBase58(),
  mintA: mintA.toBase58(), mintB: mintB.toBase58(), inputMint: mintA.toBase58(), inputKind: "token", inputAccount: key().toBase58(),
  ataA: key().toBase58(), ataB: key().toBase58(), programA: key().toBase58(), programB: key().toBase58(), ataAExists: true, ataBExists: true,
  rangeSide: "below", liquidity: "1", balances: { input: "1000", a: "0", b: "0" },
};
const selection = { positionMint: state.positionMint, inputMint: state.inputMint, inputKind: "token" as const };
const connection = { getAccountInfo: vi.fn(async () => null), getAddressLookupTable: vi.fn(async () => ({ value: null })),
  getMultipleAccountsInfoAndContext: vi.fn(async () => ({ value: [], context: { slot: 1 } })),
  getLatestBlockhash: vi.fn(async () => ({ blockhash: key().toBase58(), lastValidBlockHeight: 200 })),
  getFeeForMessage: vi.fn(async () => ({ value: 5000 })),
};
function bundle(oversize = false) {
  return { state, quote: { passesFloor: true, requested: "1000", liquidity: "10", amountMaxA: "1000", amountMaxB: "0", expiresAt: Date.now() + 60000 },
    legs: [{ inputMint: mintA.toBase58(), outputMint: mintA.toBase58(), spend: 1000n, minOut: 1000n,
      route: !oversize ? null : { inputMint: mintA.toBase58(), outputMint: mintA.toBase58(), inAmount: "1000", routePlan: [],
        setupInstructions: [], swapInstruction: { programId: key().toBase58(), accounts: [], data: Buffer.alloc(1800).toString("base64") },
        cleanupInstruction: null, otherInstructions: [], addressesByLookupTableAddress: {},
      },
    }],
  } as never;
}
const initialKeyIndex = keyIndex;
beforeEach(() => {
  vi.stubEnv("SOFINANCE_FEE_WALLET", undefined);
  keyIndex = initialKeyIndex;
  vi.clearAllMocks(); connection.getMultipleAccountsInfoAndContext.mockResolvedValue({ value: [], context: { slot: 1 } }); vi.mocked(rpcConnection).mockReturnValue(connection as never);
  vi.mocked(readSelectedPositionState).mockResolvedValue(state as never);
  const data = createHash("sha256").update("global:increase_liquidity_v2").digest().subarray(0, 8);
  vi.mocked(buildSelectedAddInstruction).mockReturnValue(new TransactionInstruction({ programId: program, data,
    keys: [wallet, key(), pool, key(), position].map((pubkey, index) => ({ pubkey, isSigner: index === 0, isWritable: index === 2 || index === 4 })) }));
  vi.mocked(simulateAndVerifySelectedTransaction).mockResolvedValue({ endingLiquidity: "11", spentInput: "1000", dustA: "0", dustB: "0", unitsConsumed: 1000, solDebitLamports: "5000" });
});
it("rejects oversized candidates before Beam or simulation, caps retries at two, and reads selected state once", async () => {
  vi.mocked(getSelectedQuoteBundle).mockResolvedValue(bundle(true));
  await expect(buildAndSimulateSelectedZap(wallet.toBase58(), selection, "1", 9900)).rejects.toThrow("1,232 byte");
  expect(readSelectedPositionState).toHaveBeenCalledTimes(1); expect(getSelectedQuoteBundle).toHaveBeenCalledTimes(2);
  expect(vi.mocked(getSelectedQuoteBundle).mock.calls.map((call) => call[5])).toEqual([{ maxAccounts: 24 }, { maxAccounts: 20, onlyDirectRoutes: true }]);
  expect(fetchBeamTipAddress).not.toHaveBeenCalled(); expect(simulateAndVerifySelectedTransaction).not.toHaveBeenCalled();
});
it("successfully switches to a compact candidate without rereading state or simulating the oversized one", async () => {
  vi.mocked(getSelectedQuoteBundle).mockResolvedValueOnce(bundle(true)).mockResolvedValueOnce(bundle());
  const result = await buildAndSimulateSelectedZap(wallet.toBase58(), selection, "1", 9900, 100, { enforceResaleFloor: false });
  expect(result.summary.simulated).toBe(true); expect(result.summary.sizeBytes).toBeLessThanOrEqual(1232);
  expect(readSelectedPositionState).toHaveBeenCalledTimes(1); expect(simulateAndVerifySelectedTransaction).toHaveBeenCalledTimes(1);
  expect(fetchBeamTipAddress).toHaveBeenCalledTimes(1);
  expect(getSelectedQuoteBundle).toHaveBeenLastCalledWith(wallet.toBase58(), selection, "1", 9900, 100,
    { maxAccounts: 20, onlyDirectRoutes: true }, expect.objectContaining({ state, includeResale: false, buildTransactions: true }));
});
it("never issues transaction work after cancellation", async () => {
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  await expect(buildAndSimulateSelectedZap(wallet.toBase58(), selection, "1", 9900, 100, { signal: controller.signal })).rejects.toThrow("cancelled");
  expect(getSelectedQuoteBundle).not.toHaveBeenCalled(); expect(simulateAndVerifySelectedTransaction).not.toHaveBeenCalled();
});


function writableBundle(address: PublicKey) {
  const value = bundle(true) as unknown as Awaited<ReturnType<typeof getSelectedQuoteBundle>>;
  const route = value.legs[0]!.route as unknown as { swapInstruction: { accounts: unknown[]; data: string } };
  route.swapInstruction.accounts = [{ pubkey: address.toBase58(), isSigner: false, isWritable: true }];
  route.swapInstruction.data = Buffer.from([1]).toString("base64");
  return value;
}
function rawTokenAccount(owner: PublicKey, token2022 = false) {
  const data = Buffer.alloc(token2022 ? 166 : 165); mintB.toBuffer().copy(data); owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(1n, 64); data[108] = 1; if (token2022) data[165] = 2;
  return { data, owner: token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID, executable: false, lamports: 2039280, rentEpoch: 0 };
}
it.each([false, true])("rejects Jupiter writes to a positive unselected wallet account (Token-2022: %s)", async (token2022) => {
  const address = key(); vi.mocked(getSelectedQuoteBundle).mockResolvedValue(writableBundle(address));
  connection.getMultipleAccountsInfoAndContext.mockResolvedValueOnce({ context: { slot: 1 }, value: [rawTokenAccount(wallet, token2022)] } as never);
  await expect(buildAndSimulateSelectedZap(wallet.toBase58(), selection, "1", 9900)).rejects.toThrow("unselected wallet assets");
  expect(fetchBeamTipAddress).not.toHaveBeenCalled(); expect(simulateAndVerifySelectedTransaction).not.toHaveBeenCalled();
});
it.each(["Token-2022 mint", "external pool vault"])("accepts a writable %s without interpreting it as a funded wallet account", async (kind) => {
  const address = key(); vi.mocked(getSelectedQuoteBundle).mockResolvedValue(writableBundle(address));
  const account = rawTokenAccount(pool, true);
  if (kind === "Token-2022 mint") {
    account.data = Buffer.alloc(202); account.data.writeBigUInt64LE(1000n, 36); account.data[44] = 6; account.data[45] = 1;
    account.data[165] = 1; account.data.writeUInt16LE(3, 166); account.data.writeUInt16LE(32, 168);
  }
  connection.getMultipleAccountsInfoAndContext.mockResolvedValueOnce({ context: { slot: 1 }, value: [account] } as never);
  const result = await buildAndSimulateSelectedZap(wallet.toBase58(), selection, "1", 9900);
  expect(result.summary.simulated).toBe(true); expect(simulateAndVerifySelectedTransaction).toHaveBeenCalledOnce();
});

it("snapshots the selected transaction wire bytes", async () => {
  vi.mocked(getSelectedQuoteBundle).mockResolvedValue(bundle());
  const { transaction } = await buildAndSimulateSelectedZap(wallet.toBase58(), selection, "0.001", 9900);
  expect(Buffer.from(transaction.serialize()).toString("base64")).toMatchSnapshot();
});

afterEach(() => vi.unstubAllEnvs());
it("includes the selected-add protocol transfer before the swap", async () => {
  const recipient = key();
  vi.stubEnv("SOFINANCE_FEE_WALLET", recipient.toBase58()); vi.stubEnv("SOFINANCE_FEE_BPS", "10");
  const value = writableBundle(new PublicKey(state.ataA));
  value.quote.feeBps = 10; value.quote.feeAmount = "1"; value.quote.feeWallet = recipient.toBase58();
  value.state = { ...value.state, inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", inputTokenProgram: TOKEN_PROGRAM_ID.toBase58(), inputDecimals: 6 };
  value.legs[0]!.inputMint = value.state.inputMint;
  (value.legs[0]!.route! as { inputMint: string }).inputMint = value.state.inputMint;
  vi.mocked(readSelectedPositionState).mockResolvedValue(value.state);
  value.legs[0]!.feeAmount = 1n;
  (value.legs[0]!.route! as { inAmount: string }).inAmount = "999";
  vi.mocked(getSelectedQuoteBundle).mockResolvedValue(value);
  const { transaction } = await buildAndSimulateSelectedZap(wallet.toBase58(), selection, "0.001", 9900);
  const fee = transaction.message.compiledInstructions[2]!;
  expect(transaction.message.staticAccountKeys[fee.programIdIndex]!.equals(TOKEN_PROGRAM_ID)).toBe(true);
  expect(fee.data[0]).toBe(12); // TransferChecked
  expect(Buffer.from(fee.data).readBigUInt64LE(1)).toBe(1n);
});

import BN from "bn.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { CLMM_PROGRAM_ID, ClmmInstrument } from "@raydium-io/raydium-sdk-v2";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, type ParsedTransactionWithMeta, type TransactionInstruction } from "@solana/web3.js";
import { confirmedCompoundReceipt } from "./compound-receipt";
import { importCompoundReceipt } from "./compound-recovery-import";
import type { CompoundAccount, CompoundSummary } from "./compound-types";

const key = () => Keypair.generate().publicKey;
async function fixture() {
  const wallet = key(), nft = key(), nftAta = key(), position = key(), pool = key(), protocol = key();
  const lower = key(), upper = key(), mintA = key(), mintB = key(), vaultA = key(), vaultB = key();
  const accounts: CompoundAccount[] = [];
  for (let index = 0; index < 2; index++) {
    const seed = String(index).repeat(32);
    accounts.push({ seed, address: (await PublicKey.createWithSeed(wallet, seed, TOKEN_PROGRAM_ID)).toBase58(),
      mint: (index ? mintB : mintA).toBase58(), program: TOKEN_PROGRAM_ID.toBase58(), space: 165, rentLamports: 2_039_280 });
  }
  const sources = accounts.map((account) => new PublicKey(account.address));
  const harvest = ClmmInstrument.decreaseLiquidityV2Instruction(CLMM_PROGRAM_ID, wallet, nftAta, position, pool, protocol,
    lower, upper, sources[0]!, sources[1]!, vaultA, vaultB, mintA, mintB, [], new BN(0), new BN(0), new BN(0));
  const add = ClmmInstrument.increaseLiquidityV2Instruction(CLMM_PROGRAM_ID, wallet, nftAta, position, pool, protocol,
    lower, upper, sources[0]!, sources[1]!, vaultA, vaultB, mintA, mintB, new BN(5), new BN(10), new BN(12), null);
  const partiallyDecoded = (instruction: TransactionInstruction) => ({ programId: instruction.programId,
    accounts: instruction.keys.map((item) => item.pubkey), data: bs58.encode(instruction.data) });
  const parsed = accounts.flatMap((account) => [
    { programId: SystemProgram.programId, parsed: { type: "createAccountWithSeed", info: {
      source: wallet.toBase58(), base: wallet.toBase58(), newAccount: account.address, seed: account.seed,
      owner: account.program, space: account.space, lamports: account.rentLamports,
    } } },
    { programId: TOKEN_PROGRAM_ID, parsed: { type: "initializeAccount3", info: {
      account: account.address, mint: account.mint, owner: wallet.toBase58(),
    } } },
  ]);
  const transfer = (source: string, destination: string, amount: string) => ({ program: "spl-token", programId: TOKEN_PROGRAM_ID,
    parsed: { type: "transferChecked", info: { source, destination,
      mint: source === vaultA.toBase58() || source === accounts[0]!.address ? mintA.toBase58() : mintB.toBase58(),
      authority: accounts.some((account) => account.address === source) ? wallet.toBase58() : pool.toBase58(), tokenAmount: { amount, decimals: 6 } } } });
  const balance = (accountIndex: number, mint: string, amount: string) => ({ accountIndex, mint,
    owner: wallet.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(),
    uiTokenAmount: { amount, decimals: 6, uiAmount: null, uiAmountString: "0" } });
  const transaction = { slot: 1, transaction: { signatures: [bs58.encode(new Uint8Array(64).fill(1))], message: {
    accountKeys: [wallet, nftAta, sources[0]!, sources[1]!].map((pubkey, index) => ({ pubkey, signer: index === 0, writable: index !== 1, source: "transaction" })),
    instructions: [...parsed, partiallyDecoded(harvest), partiallyDecoded(add)],
  } }, meta: { err: null, fee: 5000, preTokenBalances: [balance(1, nft.toBase58(), "1")],
    postTokenBalances: [balance(1, nft.toBase58(), "1"), balance(2, mintA.toBase58(), "3"), balance(3, mintB.toBase58(), "4")],
    innerInstructions: [{ index: 4, instructions: [transfer(vaultA.toBase58(), accounts[0]!.address, "10"), transfer(vaultB.toBase58(), accounts[1]!.address, "12")] },
      { index: 5, instructions: [transfer(accounts[0]!.address, vaultA.toBase58(), "7"), transfer(accounts[1]!.address, vaultB.toBase58(), "8")] }],
  } } as unknown as ParsedTransactionWithMeta;
  const summary = { operation: "compound", positionMint: nft.toBase58(), positionAccount: position.toBase58(), poolId: pool.toBase58(),
    liquidity: "5", amountMaxA: "10", amountMaxB: "12", compoundAccounts: accounts,
    state: { wallet: wallet.toBase58(), programId: CLMM_PROGRAM_ID.toBase58(), nftAta: nftAta.toBase58(), vaultA: vaultA.toBase58(), vaultB: vaultB.toBase58(), rewards: [] },
  } as unknown as CompoundSummary;
  return { wallet: wallet.toBase58(), transaction, summary };
}

describe("historical compound proof", () => {
  it("uses actual per-transaction transfer credits/debits, including excess harvest dust", async () => {
    const { wallet, transaction, summary } = await fixture();
    expect(confirmedCompoundReceipt(transaction, wallet, summary)).toMatchObject({
      harvestedA: "10", harvestedB: "12", investedA: "7", investedB: "8", remainingA: "3", remainingB: "4", liquidityAdded: "5",
    });
    const changed = { ...summary, state: { ...summary.state, programId: key().toBase58() } };
    expect(confirmedCompoundReceipt(transaction, wallet, changed)).toBeNull();
  });
  it("rejects wrong ledger, pre-existing sources, principal removal and another position", async () => {
    const { wallet, transaction, summary } = await fixture();
    expect(confirmedCompoundReceipt(transaction, wallet, { ...summary, positionAccount: key().toBase58() })).toBeNull();
    transaction.meta!.postTokenBalances![1]!.uiTokenAmount.amount = "4";
    expect(confirmedCompoundReceipt(transaction, wallet, summary)).toBeNull();
    transaction.meta!.postTokenBalances![1]!.uiTokenAmount.amount = "3";
    transaction.meta!.preTokenBalances!.push({ ...transaction.meta!.postTokenBalances![1]!, uiTokenAmount: { ...transaction.meta!.postTokenBalances![1]!.uiTokenAmount, amount: "1" } });
    expect(confirmedCompoundReceipt(transaction, wallet, summary)).toBeNull();
    transaction.meta!.preTokenBalances!.pop();
    const harvest = transaction.transaction.message.instructions[4]!;
    if ("data" in harvest) { const data = Buffer.from(bs58.decode(harvest.data)); data.writeBigUInt64LE(1n, 8); harvest.data = bs58.encode(data); }
    expect(confirmedCompoundReceipt(transaction, wallet, summary)).toBeNull();
  });
});

describe("recovering after browser storage is lost", () => {
  it("reconstructs both original yield accounts from on-chain creation evidence", async () => {
    const { wallet, transaction, summary } = await fixture();
    const signature = transaction.transaction.signatures[0]!;
    const receipt = await importCompoundReceipt(transaction, wallet, signature);
    expect(receipt).toEqual({ wallet, sourceSignature: signature, positionMint: summary.positionMint, compoundAccounts: summary.compoundAccounts });
  });
  it("rejects a different initializer owner, forged seed or failed transaction", async () => {
    const { wallet, transaction } = await fixture();
    const signature = transaction.transaction.signatures[0]!;
    const init = transaction.transaction.message.instructions[1]!;
    if ("parsed" in init) init.parsed.info.owner = key().toBase58();
    await expect(importCompoundReceipt(transaction, wallet, signature)).rejects.toThrow("initialization owner");
    if ("parsed" in init) init.parsed.info.owner = wallet;
    const create = transaction.transaction.message.instructions[0]!;
    if ("parsed" in create) create.parsed.info.seed = "f".repeat(32);
    await expect(importCompoundReceipt(transaction, wallet, signature)).rejects.toThrow("seed");
    transaction.meta!.err = { InstructionError: [0, "InvalidArgument"] };
    await expect(importCompoundReceipt(transaction, wallet, signature)).rejects.toThrow(/successful/i);
  });
});

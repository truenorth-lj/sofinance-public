import BN from "bn.js";
import bs58 from "bs58";
import { CLMM_PROGRAM_ID, ClmmInstrument, getPdaExBitmapAccount, getPdaObservationAccount, getPdaTickArrayAddress } from "@raydium-io/raydium-sdk-v2";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, type ParsedTransactionWithMeta, type TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { confirmedCompoundReceipt } from "./compound-receipt";
import type { CompoundAccount, CompoundSummary } from "./compound-types";

const key = () => Keypair.generate().publicKey;
const pub = (value: string) => new PublicKey(value);
const decoded = (instruction: TransactionInstruction) => ({ programId: instruction.programId,
  accounts: instruction.keys.map((account) => account.pubkey), data: bs58.encode(instruction.data) });
const parsed = (programId: PublicKey, type: string, info: Record<string, unknown>) => ({
  program: programId.equals(SystemProgram.programId) ? "system" : "spl-token", programId, parsed: { type, info },
});
const transfer = (source: string, destination: string, amount: string, decimals: number) =>
  parsed(TOKEN_2022_PROGRAM_ID, "transferChecked", { source, destination, tokenAmount: { amount, decimals } });

async function fixture() {
  const wallet = key(), nft = key(), nftAta = key(), position = key(), pool = key(), protocol = key();
  const mintA = key(), mintB = key(), vaultA = key(), vaultB = key(), config = key();
  const lower = getPdaTickArrayAddress(CLMM_PROGRAM_ID, pool, 46_020).publicKey;
  const upper = lower;
  const sources: CompoundAccount[] = [];
  for (let index = 0; index < 2; index++) {
    const seed = String(index).repeat(22);
    sources.push({ seed, address: (await PublicKey.createWithSeed(wallet, seed, TOKEN_2022_PROGRAM_ID)).toBase58(),
      mint: (index === 0 ? mintA : mintB).toBase58(), program: TOKEN_2022_PROGRAM_ID.toBase58(), space: 478, rentLamports: 3_078_480 });
  }
  const accounts = sources as [CompoundAccount, CompoundAccount];
  const priorA = key(), priorB = key(), priorSignature = bs58.encode(new Uint8Array(64).fill(2));
  const owner = wallet.toBase58();
  const harvest = ClmmInstrument.decreaseLiquidityV2Instruction(CLMM_PROGRAM_ID, wallet, nftAta, position, pool, protocol,
    lower, upper, pub(accounts[0].address), pub(accounts[1].address), vaultA, vaultB, mintA, mintB, [], new BN(0), new BN(0), new BN(0));
  const swap = ClmmInstrument.swapV2Instruction(CLMM_PROGRAM_ID, wallet, pool, config, pub(accounts[1].address), pub(accounts[0].address),
    vaultB, vaultA, mintB, mintA, [lower], getPdaObservationAccount(CLMM_PROGRAM_ID, pool).publicKey,
    new BN(1_198_201), new BN(11_925), new BN(0), true, getPdaExBitmapAccount(CLMM_PROGRAM_ID, pool).publicKey);
  const add = ClmmInstrument.increaseLiquidityV2Instruction(CLMM_PROGRAM_ID, wallet, nftAta, position, pool, protocol,
    lower, upper, pub(accounts[0].address), pub(accounts[1].address), vaultA, vaultB, mintA, mintB,
    new BN(599_339_756), new BN(11_985), new BN(0), null);
  const accountKeys = [wallet, nftAta, pub(accounts[0].address), pub(accounts[1].address), priorA, priorB];
  const balance = (accountIndex: number, mint: PublicKey, amount: string, decimals: number, programId = TOKEN_2022_PROGRAM_ID) => ({
    accountIndex, mint: mint.toBase58(), owner, programId: programId.toBase58(),
    uiTokenAmount: { amount, decimals, uiAmount: null, uiAmountString: "0" },
  });
  const instructions = [...accounts.flatMap((account) => [
    parsed(SystemProgram.programId, "createAccountWithSeed", { source: owner, base: owner, newAccount: account.address,
      seed: account.seed, owner: account.program, space: account.space, lamports: account.rentLamports }),
    parsed(TOKEN_2022_PROGRAM_ID, "initializeAccount3", { account: account.address, mint: account.mint, owner }),
  ]), parsed(TOKEN_2022_PROGRAM_ID, "closeAccount", { account: priorA.toBase58(), destination: owner, owner }),
  parsed(TOKEN_2022_PROGRAM_ID, "transferChecked", { source: priorB.toBase58(), destination: accounts[1].address,
    authority: owner, mint: mintB.toBase58(), tokenAmount: { amount: "1198201", decimals: 8 } }),
  parsed(TOKEN_2022_PROGRAM_ID, "closeAccount", { account: priorB.toBase58(), destination: owner, owner }),
  decoded(harvest), decoded(swap), decoded(add)];
  const transaction = { slot: 1, transaction: { signatures: [bs58.encode(new Uint8Array(64).fill(3))], message: {
    accountKeys: accountKeys.map((pubkey, index) => ({ pubkey, signer: index === 0, writable: index !== 1, source: "transaction" })),
    instructions,
  } }, meta: { err: null, fee: 5000,
    preTokenBalances: [balance(1, nft, "1", 0, TOKEN_PROGRAM_ID), balance(4, mintA, "0", 6), balance(5, mintB, "1198201", 8)],
    postTokenBalances: [balance(1, nft, "1", 0, TOKEN_PROGRAM_ID), balance(2, mintA, "0", 6), balance(3, mintB, "0", 8)],
    innerInstructions: [{ index: 7, instructions: [] }, { index: 8, instructions: [
      transfer(accounts[1].address, vaultB.toBase58(), "1198201", 8), transfer(vaultA.toBase58(), accounts[0].address, "11985", 6),
    ] }, { index: 9, instructions: [transfer(accounts[0].address, vaultA.toBase58(), "11985", 6)] }],
  } } as unknown as ParsedTransactionWithMeta;
  const summary = { operation: "compound", positionMint: nft.toBase58(), positionAccount: position.toBase58(), poolId: pool.toBase58(),
    startingLiquidity: "772749848369", liquidity: "599339756", amountMaxA: "11985", amountMaxB: "0", compoundAccounts: accounts,
    state: { wallet: owner, positionMint: nft.toBase58(), programId: CLMM_PROGRAM_ID.toBase58(), nftAta: nftAta.toBase58(),
      mintA: mintA.toBase58(), mintB: mintB.toBase58(), vaultA: vaultA.toBase58(), vaultB: vaultB.toBase58(), rewards: [] },
    swaps: [{ inputMint: mintB.toBase58(), outputMint: mintA.toBase58(), inputAmount: "1198201", quotedOutputAmount: "11985",
      minOutputAmount: "11925", inputDecimals: 8, outputDecimals: 6, poolId: pool.toBase58(), sqrtPriceAfterX64: "18446744073709551616" }],
    priorSources: [priorA, priorB].map((address, index) => ({ address: address.toBase58(), sourceSignature: priorSignature,
      mint: accounts[index]!.mint, program: TOKEN_2022_PROGRAM_ID.toBase58(), amount: index === 0 ? "0" : "1198201",
      destination: accounts[index]!.address, refundLamports: 3_078_480 })),
  } as unknown as CompoundSummary;
  return { transaction, summary, wallet: owner, instructions, balance, mintA, mintB };
}

describe("full compound historical ledger", () => {
  it("proves that all prior yield is swapped and reinvested, independently of newer balances", async () => {
    const { transaction, summary, wallet } = await fixture();
    expect(confirmedCompoundReceipt(transaction, wallet, summary)).toMatchObject({
      harvestedA: "0", harvestedB: "0", priorYieldA: "0", priorYieldB: "1198201",
      investedA: "11985", investedB: "0", remainingA: "0", remainingB: "0", liquidityAdded: "599339756",
      swaps: [{ inputMint: summary.swaps![0]!.inputMint, outputMint: summary.swaps![0]!.outputMint, inputAmount: "1198201", outputAmount: "11985" }],
    });
  });
  it("rejects altered swap input or minimum output authorization", async () => {
    for (const field of ["inputAmount", "minOutputAmount"] as const) {
      const { transaction, summary, wallet } = await fixture();
      summary.swaps![0]![field] = field === "inputAmount" ? "1198200" : "11924";
      expect(confirmedCompoundReceipt(transaction, wallet, summary)).toBeNull();
    }
  });
  it("rejects CPI spend or output discrepancies and output below the approved minimum", async () => {
    const spend = await fixture();
    const input = spend.transaction.meta!.innerInstructions![1]!.instructions[0]!;
    if ("parsed" in input) input.parsed.info.tokenAmount.amount = "1198200";
    expect(confirmedCompoundReceipt(spend.transaction, spend.wallet, spend.summary)).toBeNull();
    const output = await fixture();
    const received = output.transaction.meta!.innerInstructions![1]!.instructions[1]!;
    if ("parsed" in received) received.parsed.info.tokenAmount.amount = "11924";
    expect(confirmedCompoundReceipt(output.transaction, output.wallet, output.summary)).toBeNull();
  });
  it("rejects a forged prior balance or absent prior transfer and close instructions", async () => {
    const amount = await fixture(); amount.summary.priorSources![1]!.amount = "1198200";
    expect(confirmedCompoundReceipt(amount.transaction, amount.wallet, amount.summary)).toBeNull();
    const transferCase = await fixture();
    const transferred = transferCase.transaction.transaction.message.instructions[5]!;
    if ("parsed" in transferred) transferred.parsed.info.tokenAmount.amount = "1198200";
    expect(confirmedCompoundReceipt(transferCase.transaction, transferCase.wallet, transferCase.summary)).toBeNull();
    const close = await fixture();
    const closed = close.transaction.transaction.message.instructions[6]!;
    if ("parsed" in closed) closed.parsed.type = "freezeAccount";
    expect(confirmedCompoundReceipt(close.transaction, close.wallet, close.summary)).toBeNull();
  });
  it("rejects an unclosed source in transaction balance metadata", async () => {
    const { transaction, summary, wallet, balance, mintB } = await fixture();
    transaction.meta!.postTokenBalances!.push(balance(5, mintB, "0", 8));
    expect(confirmedCompoundReceipt(transaction, wallet, summary)).toBeNull();
  });
  it("rejects changed swap source, mint or position NFT ownership", async () => {
    const source = await fixture(); const swap = source.transaction.transaction.message.instructions[8]!;
    if ("accounts" in swap) swap.accounts[3] = key();
    expect(confirmedCompoundReceipt(source.transaction, source.wallet, source.summary)).toBeNull();
    const mint = await fixture(); mint.transaction.meta!.postTokenBalances![1]!.mint = key().toBase58();
    expect(confirmedCompoundReceipt(mint.transaction, mint.wallet, mint.summary)).toBeNull();
    const nft = await fixture(); nft.transaction.meta!.postTokenBalances![0]!.owner = key().toBase58();
    expect(confirmedCompoundReceipt(nft.transaction, nft.wallet, nft.summary)).toBeNull();
  });
  it("rejects an altered liquidity increase, add cap or final remainder", async () => {
    const cap = await fixture(); cap.summary.amountMaxA = "11984";
    expect(confirmedCompoundReceipt(cap.transaction, cap.wallet, cap.summary)).toBeNull();
    const liquidity = await fixture(); liquidity.summary.liquidity = "599339755";
    expect(confirmedCompoundReceipt(liquidity.transaction, liquidity.wallet, liquidity.summary)).toBeNull();
    const dust = await fixture(); dust.transaction.meta!.postTokenBalances![1]!.uiTokenAmount.amount = "1";
    expect(confirmedCompoundReceipt(dust.transaction, dust.wallet, dust.summary)).toBeNull();
  });
  it("refuses full-success proof when an unexpected third reward was claimed", async () => {
    const { transaction, summary, wallet } = await fixture();
    const mint = key().toBase58(), vault = key().toBase58(), account = key().toBase58();
    summary.state.rewards = [{ index: 0, mint, vault, account, program: TOKEN_2022_PROGRAM_ID.toBase58(),
      decimals: 6, estimatedAmount: "0", compounded: false }];
    const harvest = transaction.transaction.message.instructions[7]!;
    if ("accounts" in harvest) harvest.accounts.push(pub(vault), pub(account), pub(mint));
    transaction.meta!.innerInstructions![0]!.instructions.push(transfer(vault, account, "1", 6));
    expect(confirmedCompoundReceipt(transaction, wallet, summary)).toBeNull();
  });
});

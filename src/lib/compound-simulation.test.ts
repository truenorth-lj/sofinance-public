import { createHash } from "node:crypto";
import { PersonalPositionLayout, PoolInfoLayout } from "@raydium-io/raydium-sdk-v2";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type AccountInfo } from "@solana/web3.js";
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { simulateAndVerifyCompound } from "./compound-simulation";
import type { CompoundAccount, CompoundPositionState, CompoundPriorSource } from "./compound-types";

const key = () => Keypair.generate().publicKey.toBase58();
function info(data: Buffer, owner: PublicKey, lamports = 2_039_280): AccountInfo<Buffer> { return { data, owner, lamports, executable: false, rentEpoch: 0 }; }
function tokenData(mint: string, wallet: string, amount: bigint) {
  const data = Buffer.alloc(165);
  new PublicKey(mint).toBuffer().copy(data, 0);
  new PublicKey(wallet).toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64); data[108] = 1;
  return data;
}
async function fixture() {
  const state = { wallet: key(), positionMint: key(), positionAccount: key(), poolId: key(), programId: key(),
    mintA: key(), mintB: key(), ataA: key(), ataB: key(), nftAta: key(),
    programA: TOKEN_PROGRAM_ID.toBase58(), programB: TOKEN_PROGRAM_ID.toBase58(), nftProgram: TOKEN_PROGRAM_ID.toBase58(),
    tickLower: -100, tickUpper: 100, liquidity: "100", rewards: [] } as unknown as CompoundPositionState;
  const accounts = await Promise.all([state.mintA, state.mintB].map(async (mint, index) => {
    const seed = (index ? "b" : "a").repeat(32);
    return { mint, seed, program: TOKEN_PROGRAM_ID.toBase58(), address: (await PublicKey.createWithSeed(new PublicKey(state.wallet), seed, TOKEN_PROGRAM_ID)).toBase58(), space: 165, rentLamports: 2_039_280 };
  })) as [CompoundAccount, CompoundAccount];
  const positionData = (liquidity: bigint, tickLower = -100) => {
    const data = Buffer.alloc(PersonalPositionLayout.span);
    createHash("sha256").update("account:PersonalPositionState").digest().copy(data, 0, 0, 8);
    new PublicKey(state.positionMint).toBuffer().copy(data, PersonalPositionLayout.offsetOf("nftMint"));
    new PublicKey(state.poolId).toBuffer().copy(data, PersonalPositionLayout.offsetOf("poolId"));
    data.writeInt32LE(tickLower, PersonalPositionLayout.offsetOf("tickLower"));
    data.writeInt32LE(100, PersonalPositionLayout.offsetOf("tickUpper"));
    data.writeBigUInt64LE(liquidity, PersonalPositionLayout.offsetOf("liquidity"));
    return data;
  };
  const before = new Map<string, AccountInfo<Buffer>>([
    [state.positionAccount, info(positionData(100n), new PublicKey(state.programId))],
    [state.nftAta, info(tokenData(state.positionMint, state.wallet, 1n), TOKEN_PROGRAM_ID)],
    [state.ataA, info(tokenData(state.mintA, state.wallet, 77n), TOKEN_PROGRAM_ID)],
    [state.ataB, info(tokenData(state.mintB, state.wallet, 88n), TOKEN_PROGRAM_ID)],
    [state.wallet, info(Buffer.alloc(0), SystemProgram.programId, 100_000_000)],
  ]);
  const poolData = Buffer.alloc(PoolInfoLayout.span);
  new PublicKey(state.mintA).toBuffer().copy(poolData, PoolInfoLayout.offsetOf("mintA"));
  new PublicKey(state.mintB).toBuffer().copy(poolData, PoolInfoLayout.offsetOf("mintB"));
  poolData.writeBigUInt64LE(1n, PoolInfoLayout.offsetOf("sqrtPriceX64") + 8);
  before.set(state.poolId, info(poolData, new PublicKey(state.programId)));
  const after = new Map(before);
  after.set(state.positionAccount, info(positionData(105n), new PublicKey(state.programId)));
  after.set(accounts[0].address, info(tokenData(state.mintA, state.wallet, 2n), TOKEN_PROGRAM_ID));
  after.set(accounts[1].address, info(tokenData(state.mintB, state.wallet, 3n), TOKEN_PROGRAM_ID));
  after.set(state.wallet, info(Buffer.alloc(0), SystemProgram.programId, 95_000_000));
  const connection = {
    getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map((key) => before.get(key.toBase58()) ?? null)),
    simulateTransaction: vi.fn(async (_transaction, config: { accounts: { addresses: string[] } }) => ({ value: { err: null, unitsConsumed: 100_000,
      accounts: config.accounts.addresses.map((address) => {
        const item = after.get(address);
        return item ? { ...item, owner: item.owner.toBase58(), data: [item.data.toString("base64"), "base64"] } : null;
      }) } })),
  } as unknown as Connection;
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(state.wallet), recentBlockhash: key(), instructions: [] }).compileToV0Message());
  return { input: { connection, transaction, state, compoundAccounts: accounts, expectedLiquidity: 5n, maxSolDebitLamports: 5_100_000n, sigVerify: false }, before, after, positionData };
}
it("keeps NFT ownership, exact ticks and existing wallet A/B while adding only isolated yield", async () => {
  const { input } = await fixture();
  expect(await simulateAndVerifyCompound(input)).toMatchObject({ endingLiquidity: "105", endingA: "2", endingB: "3", solDebitLamports: "5000000" });
});
it("rejects preexisting source accounts even if empty, so a harvest race cannot spend previous principal", async () => {
  const { input, before } = await fixture();
  before.set(input.compoundAccounts[0].address, info(tokenData(input.state.mintA, input.state.wallet, 0n), TOKEN_PROGRAM_ID));
  await expect(simulateAndVerifyCompound(input)).rejects.toThrow("already exist");
  expect(input.connection.simulateTransaction).not.toHaveBeenCalled();
});
it("rejects a changed range or withdrawn liquidity and an existing wallet debit", async () => {
  const { input, after, positionData } = await fixture();
  after.set(input.state.positionAccount, info(positionData(105n, -101), new PublicKey(input.state.programId)));
  await expect(simulateAndVerifyCompound(input)).rejects.toThrow("ticks");
  after.set(input.state.positionAccount, info(positionData(99n), new PublicKey(input.state.programId)));
  await expect(simulateAndVerifyCompound(input)).rejects.toThrow("liquidity");
  after.set(input.state.positionAccount, info(positionData(105n), new PublicKey(input.state.programId)));
  after.set(input.state.ataA, info(tokenData(input.state.mintA, input.state.wallet, 76n), TOKEN_PROGRAM_ID));
  await expect(simulateAndVerifyCompound(input)).rejects.toThrow("existing wallet");
});
it("fails when harvested yield no longer funds the add, rather than accepting a wallet-funded fallback", async () => {
  const { input } = await fixture();
  vi.mocked(input.connection.simulateTransaction).mockResolvedValueOnce({ value: { err: { InstructionError: [6, "InsufficientFunds"] }, logs: ["yield source insufficient"] } } as never);
  await expect(simulateAndVerifyCompound(input)).rejects.toThrow("InsufficientFunds");
});
it("counts a shared reward ATA credit only once when two reward vaults use the same mint", async () => {
  const { input, before, after } = await fixture();
  const mint = key(), account = key();
  input.state.rewards = [0, 1].map((index) => ({ index, mint, account, vault: key(), program: TOKEN_PROGRAM_ID.toBase58(), decimals: 6, estimatedAmount: "5", compounded: false }));
  before.set(account, info(tokenData(mint, input.state.wallet, 20n), TOKEN_PROGRAM_ID));
  after.set(account, info(tokenData(mint, input.state.wallet, 30n), TOKEN_PROGRAM_ID));
  expect((await simulateAndVerifyCompound(input)).rewards).toEqual([{ mint, amount: "10", compounded: false }]);
});
it("rejects changed prior-yield balance before simulating and requires its atomic closure", async () => {
  const { input, before, after } = await fixture();
  const address = key();
  const source: CompoundPriorSource = { address, mint: input.state.mintB, program: input.state.programB,
    destination: input.compoundAccounts[1].address, amount: "5", sourceSignature: "public-source-proof", refundLamports: 2_039_280 };
  before.set(address, info(tokenData(source.mint, input.state.wallet, 6n), TOKEN_PROGRAM_ID));
  await expect(simulateAndVerifyCompound({ ...input, priorSources: [source] })).rejects.toThrow("balance");
  expect(input.connection.simulateTransaction).not.toHaveBeenCalled();
  before.set(address, info(tokenData(source.mint, input.state.wallet, 5n), TOKEN_PROGRAM_ID));
  after.set(address, info(tokenData(source.mint, input.state.wallet, 0n), TOKEN_PROGRAM_ID));
  await expect(simulateAndVerifyCompound({ ...input, priorSources: [source] })).rejects.toThrow("close");
  after.set(address, info(Buffer.alloc(0), SystemProgram.programId, 0));
  expect(await simulateAndVerifyCompound({ ...input, priorSources: [source] })).toMatchObject({ endingA: "2", endingB: "3" });
});
it("allows only the proven prior-account rent refund when SOL debit is negative", async () => {
  const { input, before, after } = await fixture();
  const source: CompoundPriorSource = { address: key(), mint: input.state.mintA, program: input.state.programA,
    destination: input.compoundAccounts[0].address, amount: "0", sourceSignature: "public-source-proof", refundLamports: 2_039_280 };
  before.set(source.address, info(tokenData(source.mint, input.state.wallet, 0n), TOKEN_PROGRAM_ID));
  after.set(input.state.wallet, info(Buffer.alloc(0), SystemProgram.programId, 102_000_000));
  expect(await simulateAndVerifyCompound({ ...input, priorSources: [source] })).toMatchObject({ solDebitLamports: "-2000000" });
  after.set(input.state.wallet, info(Buffer.alloc(0), SystemProgram.programId, 103_000_000));
  await expect(simulateAndVerifyCompound({ ...input, priorSources: [source] })).rejects.toThrow("SOL");
});

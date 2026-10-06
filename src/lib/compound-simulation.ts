import "server-only";

import { PersonalPositionLayout, PoolInfoLayout } from "@raydium-io/raydium-sdk-v2";
import { unpackAccount } from "@solana/spl-token";
import { Connection, PublicKey, SystemProgram, VersionedTransaction, type AccountInfo } from "@solana/web3.js";
import { MIN_SOL_LAMPORTS } from "./ids";
import type { CompoundAccount, CompoundPositionState, CompoundPriorSource } from "./compound-types";

export type CompoundSimulationInput = {
  connection: Connection; transaction: VersionedTransaction; state: CompoundPositionState;
  compoundAccounts: [CompoundAccount, CompoundAccount]; expectedLiquidity: bigint;
  maxSolDebitLamports: bigint; sigVerify: boolean;
  priorSources?: CompoundPriorSource[];
};
export function compoundTokenAmount(info: AccountInfo<Buffer> | null, address: string, program: string, wallet: string, mint: string) {
  if (!info) return 0n;
  if (info.owner.toBase58() !== program) throw new Error("Compound token program mismatch");
  const token = unpackAccount(new PublicKey(address), info, new PublicKey(program));
  if (token.owner.toBase58() !== wallet || token.mint.toBase58() !== mint || token.isFrozen) throw new Error("Compound token owner, mint, or status mismatch");
  return token.amount;
}

/** expectedLiquidity=0 verifies the harvest-only baseline; >0 verifies compound. */
export async function simulateAndVerifyCompound(input: CompoundSimulationInput) {
  const { connection, transaction, state, compoundAccounts, expectedLiquidity, sigVerify, maxSolDebitLamports, priorSources = [] } = input;
  const wallet = new PublicKey(state.wallet);
  if (transaction.message.header.numRequiredSignatures !== 1 || !transaction.message.staticAccountKeys[0]?.equals(wallet)) throw new Error("Compound only allows selected wallet signature");
  for (let index = 0; index < compoundAccounts.length; index++) {
    const account = compoundAccounts[index]!;
    if (!/^(?:[0-9a-f]{32}|[A-Za-z0-9_-]{22})$/.test(account.seed) || (await PublicKey.createWithSeed(wallet, account.seed, new PublicKey(account.program))).toBase58() !== account.address ||
      account.mint !== (index === 0 ? state.mintA : state.mintB) || account.program !== (index === 0 ? state.programA : state.programB)) throw new Error("Isolated yield account seed, address, or mint mismatch");
  }
  const isolated = compoundAccounts.map((account) => account.address);
  const tokens = [
    { address: state.nftAta, program: state.nftProgram, mint: state.positionMint },
    { address: state.ataA, program: state.programA, mint: state.mintA },
    { address: state.ataB, program: state.programB, mint: state.mintB },
    ...compoundAccounts,
    ...priorSources,
    ...state.rewards.filter((reward) => !reward.compounded).map((reward) => ({ ...reward, address: reward.account })),
  ];
  const unique = [...new Map(tokens.map((token) => [token.address, token])).values()];
  const addresses = [state.positionAccount, state.poolId, ...unique.map((token) => token.address), state.wallet];
  const infos = await connection.getMultipleAccountsInfo(addresses.map((address) => new PublicKey(address)), "confirmed");
  const before = new Map(addresses.map((address, index) => [address, infos[index] ?? null]));
  const startPositionInfo = before.get(state.positionAccount);
  if (!startPositionInfo || startPositionInfo.owner.toBase58() !== state.programId) throw new Error("Compound position account does not exist");
  const start = PersonalPositionLayout.decode(startPositionInfo.data);
  if (start.nftMint.toBase58() !== state.positionMint || start.poolId.toBase58() !== state.poolId || start.tickLower !== state.tickLower || start.tickUpper !== state.tickUpper || start.liquidity.toString() !== state.liquidity) throw new Error("Pre-compound position identity or liquidity has changed");
  if (isolated.some((address) => before.get(address))) throw new Error("This round's isolated yield accounts already exist, please reprepare transaction");
  const beforeAmount = (address: string) => {
    const token = unique.find((item) => item.address === address)!;
    return compoundTokenAmount(before.get(address) ?? null, address, token.program, state.wallet, token.mint);
  };
  if (beforeAmount(state.nftAta) !== 1n) throw new Error("NFT no longer held by wallet before compound");
  for (const source of priorSources) {
    if (beforeAmount(source.address) !== BigInt(source.amount) ||
      !compoundAccounts.some((account) => account.address === source.destination && account.mint === source.mint && account.program === source.program)) {
      throw new Error("Prior yield account balance or restoration destination has changed");
    }
  }
  const solBefore = BigInt(before.get(state.wallet)?.lamports ?? 0);
  const result = await connection.simulateTransaction(transaction, { sigVerify, commitment: "confirmed", accounts: { encoding: "base64", addresses } });
  if (result.value.err) throw new Error(`Compound simulation failed: ${JSON.stringify(result.value.err)}; ${result.value.logs?.slice(-5).join(" | ") || "no logs"}`);
  const after = new Map(addresses.map((address, index) => {
    const account = result.value.accounts?.[index];
    if (account && typeof account.data[0] !== "string") throw new Error("Simulation account data missing");
    return [address, account ? { owner: new PublicKey(account.owner), data: Buffer.from(account.data[0]!, "base64"),
      executable: account.executable, lamports: account.lamports, rentEpoch: account.rentEpoch ?? 0 } : null] as const;
  }));
  const positionInfo = after.get(state.positionAccount);
  if (!positionInfo || positionInfo.owner.toBase58() !== state.programId) throw new Error("Simulation did not read back compound position");
  const position = PersonalPositionLayout.decode(positionInfo.data);
  if (position.nftMint.toBase58() !== state.positionMint || position.poolId.toBase58() !== state.poolId || position.tickLower !== state.tickLower || position.tickUpper !== state.tickUpper ||
    BigInt(position.liquidity.toString()) !== BigInt(state.liquidity) + expectedLiquidity) throw new Error("Compound simulation modified NFT, ticks, or liquidity increment mismatch");
  const afterAmount = (address: string) => {
    const token = unique.find((item) => item.address === address)!;
    return compoundTokenAmount(after.get(address) ?? null, address, token.program, state.wallet, token.mint);
  };
  if (afterAmount(state.nftAta) !== 1n) throw new Error("NFT left wallet after compound simulation");
  for (const address of [state.ataA, state.ataB]) if (afterAmount(address) !== beforeAmount(address)) throw new Error("Compound simulation used existing wallet pool assets");
  for (const source of priorSources) {
    const closed = after.get(source.address);
    // Simulation may expose a just-closed account as an empty zero-lamport
    // system account until the bank purges it, rather than returning null.
    if (closed && (closed.lamports !== 0 || closed.data.length !== 0 || !closed.owner.equals(SystemProgram.programId))) {
      throw new Error("Compound did not fully transfer and close prior yield account");
    }
  }
  const walletAfter = after.get(state.wallet);
  if (!walletAfter) throw new Error("Simulation did not read back wallet SOL");
  const solDebit = solBefore - BigInt(walletAfter.lamports);
  const refund = priorSources.reduce((sum, source) => sum + BigInt(source.refundLamports), 0n);
  if (solDebit < -refund || solDebit > maxSolDebitLamports || walletAfter.lamports < MIN_SOL_LAMPORTS) throw new Error("Compound SOL expenditure or remaining balance exceeds limit");
  // Multiple reward vaults may pay the same mint into the same owner ATA.
  // Report that ATA's aggregate credit once, not once per initialized reward.
  const retainedRewards = [...new Map(state.rewards.filter((reward) => !reward.compounded).map((reward) => [reward.mint, reward])).values()];
  const rewards = retainedRewards.map((reward) => {
    const delta = afterAmount(reward.account) - beforeAmount(reward.account);
    if (delta < 0n) throw new Error("Compound used existing reward assets");
    return { mint: reward.mint, amount: delta.toString(), compounded: false };
  });
  const poolInfo = after.get(state.poolId);
  if (!poolInfo || poolInfo.owner.toBase58() !== state.programId) throw new Error("Compound simulation did not read back pool price");
  const pool = PoolInfoLayout.decode(poolInfo.data);
  if (pool.mintA.toBase58() !== state.mintA || pool.mintB.toBase58() !== state.mintB) throw new Error("Compound simulation pool mint mismatch");
  return { unitsConsumed: result.value.unitsConsumed, endingLiquidity: position.liquidity.toString(),
    sqrtPriceX64: pool.sqrtPriceX64.toString(),
    endingA: afterAmount(isolated[0]!).toString(), endingB: afterAmount(isolated[1]!).toString(),
    solDebitLamports: solDebit.toString(), rewards };
}

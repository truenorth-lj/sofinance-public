import "server-only";

import { createHash, randomBytes } from "node:crypto";
import BN from "bn.js";
import { ClmmInstrument, getPdaExBitmapAccount, getPdaProtocolPositionAddress, getPdaTickArrayAddress, PersonalPositionLayout, Raydium, TickArrayUtil } from "@raydium-io/raydium-sdk-v2";
import { createAssociatedTokenAccountIdempotentInstruction, createInitializeAccount3Instruction, getAccountLenForMint, TOKEN_2022_PROGRAM_ID, unpackMint } from "@solana/spl-token";
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { rpcConnection } from "./rpc";
import { beamTipInstruction, chooseBeamTransaction, fetchBeamTipAddress } from "./solami-beam";
import { readLookupTables } from "./transaction-helpers";
import { restampVersionedTransaction, stampPreparedBlockhash } from "./fresh-blockhash";
import { readCompoundPositionState } from "./compound-state";
import { simulateAndVerifyCompound } from "./compound-simulation";
import { conservativeSwapBalances, sizeBufferedCompoundLiquidity } from "./compound-math";
import { buildCompoundSwapPlan } from "./compound-swap";
import { readCompoundPriorSources } from "./compound-prior-sources";
import type { CompoundAccount, CompoundPositionState, CompoundSummary } from "./compound-types";

const discriminator = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const readU128 = (data: Buffer, offset: number) => data.readBigUInt64LE(offset) + (data.readBigUInt64LE(offset + 8) << 64n);
function transactionSize(transaction: VersionedTransaction) {
  let size: number;
  try { size = transaction.serialize().length; } catch (error) {
    if (error instanceof RangeError || error instanceof Error && error.message.includes("encoding overruns Uint8Array")) throw new Error("Complete compound transaction exceeds 1,232 byte limit, this position not supported in phase one");
    throw error;
  }
  if (size > 1_232) throw new Error("Complete compound transaction exceeds 1,232 byte limit");
  return size;
}

/** Independent protocol-shape checks: harvest never removes principal; add never reads ordinary ATAs. */
export function validateCompoundRaydiumInstructions(instructions: TransactionInstruction[], state: CompoundPositionState, accounts: [CompoundAccount, CompoundAccount], liquidity: bigint, amountMaxA: bigint, amountMaxB: bigint) {
  const harvest = instructions[0];
  const add = instructions[1];
  const equal = (ix: TransactionInstruction, index: number, address: string) => ix.keys[index]?.pubkey.toBase58() === address;
  const program = new PublicKey(state.programId);
  const pool = new PublicKey(state.poolId);
  const lower = getPdaTickArrayAddress(program, pool, TickArrayUtil.getTickArrayStartIndex(state.tickLower, state.tickSpacing)).publicKey.toBase58();
  const upper = getPdaTickArrayAddress(program, pool, TickArrayUtil.getTickArrayStartIndex(state.tickUpper, state.tickSpacing)).publicKey.toBase58();
  const protocol = getPdaProtocolPositionAddress(program, pool, state.tickLower, state.tickUpper).publicKey.toBase58();
  const bitmap = getPdaExBitmapAccount(program, pool).publicKey.toBase58();
  if (instructions.length !== 2 || !harvest || !add || harvest.programId.toBase58() !== state.programId || add.programId.toBase58() !== state.programId ||
    harvest.data.length !== 40 || !harvest.data.subarray(0, 8).equals(discriminator("decrease_liquidity_v2")) || readU128(harvest.data, 8) !== 0n || harvest.data.readBigUInt64LE(24) !== 0n || harvest.data.readBigUInt64LE(32) !== 0n ||
    add.data.length !== 42 || !add.data.subarray(0, 8).equals(discriminator("increase_liquidity_v2")) || readU128(add.data, 8) !== liquidity || add.data.readBigUInt64LE(24) !== amountMaxA || add.data.readBigUInt64LE(32) !== amountMaxB || add.data[40] !== 0 || add.data[41] !== 0) throw new Error("Compound can only use zero-harvest and fixed liquidity increase");
  if (!equal(harvest, 0, state.wallet) || !equal(add, 0, state.wallet) || !harvest.keys[0]?.isSigner || !add.keys[0]?.isSigner ||
    !equal(harvest, 1, state.nftAta) || !equal(add, 1, state.nftAta) || harvest.keys[1]?.isWritable || add.keys[1]?.isWritable ||
    !equal(harvest, 2, state.positionAccount) || !equal(add, 4, state.positionAccount) || !equal(harvest, 3, state.poolId) || !equal(add, 2, state.poolId) ||
    !equal(harvest, 9, accounts[0].address) || !equal(harvest, 10, accounts[1].address) || !equal(add, 7, accounts[0].address) || !equal(add, 8, accounts[1].address) ||
    !equal(harvest, 14, state.mintA) || !equal(harvest, 15, state.mintB) || !equal(add, 13, state.mintA) || !equal(add, 14, state.mintB) ||
    !equal(harvest, 4, protocol) || !equal(add, 3, protocol) || !equal(harvest, 7, lower) || !equal(add, 5, lower) || !equal(harvest, 8, upper) || !equal(add, 6, upper) ||
    !equal(harvest, 5, state.vaultA) || !equal(add, 9, state.vaultA) || !equal(harvest, 6, state.vaultB) || !equal(add, 10, state.vaultB)) throw new Error("Compound instruction NFT, pool, or isolated yield account mismatch");
  const allowedWrites = new Set([state.poolId, state.positionAccount, state.vaultA, state.vaultB, lower, upper, bitmap, accounts[0].address, accounts[1].address,
    ...state.rewards.flatMap((reward) => [reward.vault, reward.compounded ? (reward.mint === state.mintA ? accounts[0].address : accounts[1].address) : reward.account])]);
  for (const ix of instructions) if (ix.keys.some((key) => key.isSigner && key.pubkey.toBase58() !== state.wallet ||
    key.isWritable && !allowedWrites.has(key.pubkey.toBase58()))) throw new Error("Compound must not modify existing wallet assets or mints");
  const rewardStart = harvest.keys.length - state.rewards.length * 3;
  if (rewardStart !== 16 && rewardStart !== 17) throw new Error("Compound reward accounts count mismatch");
  if (rewardStart === 17 && !equal(harvest, 16, bitmap) || add.keys.length === 16 && !equal(add, 15, bitmap) || ![15, 16].includes(add.keys.length)) throw new Error("Compound bitmap account mismatch");
  state.rewards.forEach((reward, index) => {
    const recipient = reward.mint === state.mintA ? accounts[0].address : reward.mint === state.mintB ? accounts[1].address : reward.account;
    if (!equal(harvest, rewardStart + index * 3, reward.vault) || !equal(harvest, rewardStart + index * 3 + 1, recipient) || !equal(harvest, rewardStart + index * 3 + 2, reward.mint)) throw new Error("Compound reward vault, recipient, or mint mismatch");
  });
}

export async function buildAndSimulateCompound(walletAddress: string, positionMint: string, sourceSignatures: string[] = []) {
  const connection = rpcConnection();
  const state = await readCompoundPositionState(walletAddress, positionMint, connection);
  if (!state.eligible) throw new Error(state.reason || "This position cannot be compounded");
  const wallet = new PublicKey(walletAddress);
  const setup: TransactionInstruction[] = [];
  const compoundAccounts: CompoundAccount[] = [];
  for (const [mintAddress, programAddress] of [[state.mintA, state.programA], [state.mintB, state.programB]]) {
    const mint = new PublicKey(mintAddress!);
    const program = new PublicKey(programAddress!);
    const info = await connection.getAccountInfo(mint, "confirmed");
    if (!info || !info.owner.equals(program)) throw new Error("Compound mint program has changed");
    const space = getAccountLenForMint(unpackMint(mint, info, program));
    const rentLamports = await connection.getMinimumBalanceForRentExemption(space, "confirmed");
    const seed = randomBytes(16).toString("base64url");
    const address = await PublicKey.createWithSeed(wallet, seed, program);
    // Intentionally NON-idempotent: an account funded before execution must fail,
    // not silently become a source of someone else's previous wallet principal.
    setup.push(SystemProgram.createAccountWithSeed({ fromPubkey: wallet, basePubkey: wallet, seed, newAccountPubkey: address, lamports: rentLamports, space, programId: program }),
      createInitializeAccount3Instruction(address, mint, wallet, program));
    compoundAccounts.push({ seed, address: address.toBase58(), mint: mintAddress!, program: programAddress!, space, rentLamports });
  }
  const accounts = compoundAccounts as [CompoundAccount, CompoundAccount];
  let rentLamports = accounts.reduce((sum, account) => sum + account.rentLamports, 0);
  const retainedRewards = [...new Map(state.rewards.filter((reward) => !reward.compounded).map((reward) => [reward.account, reward])).values()];
  for (const reward of retainedRewards) {
    const existing = await connection.getAccountInfo(new PublicKey(reward.account), "confirmed");
    if (!existing) {
      const mintInfo = await connection.getAccountInfo(new PublicKey(reward.mint), "confirmed");
      if (!mintInfo || mintInfo.owner.toBase58() !== reward.program) throw new Error("Reward mint program has changed");
      // ATA Token-2022 also initializes ImmutableOwner; budget a conservative
      // account extension overhead without turning this into an economic gate.
      const space = getAccountLenForMint(unpackMint(new PublicKey(reward.mint), mintInfo, mintInfo.owner)) + 16;
      rentLamports += await connection.getMinimumBalanceForRentExemption(space, "confirmed");
    }
    if (!existing) setup.push(createAssociatedTokenAccountIdempotentInstruction(wallet, new PublicKey(reward.account), wallet, new PublicKey(reward.mint), new PublicKey(reward.program)));
  }
  const prior = await readCompoundPriorSources(connection, state, accounts, sourceSignatures);
  setup.push(...prior.instructions);
  const raydium = await Raydium.load({ connection, owner: wallet, disableLoadToken: true });
  const { poolInfo, poolKeys, computePoolInfo, tickData } = await raydium.clmm.getPoolInfoFromRpc(state.poolId);
  // The off-chain entry is used exclusively to discover an optional ALT;
  // all protocol keys and token recipients remain taken from verified RPC state.
  const [apiPoolKeys] = await raydium.api.fetchPoolKeysById({ idList: [state.poolId] });
  const poolTable = apiPoolKeys?.id === state.poolId ? apiPoolKeys.lookupTableAccount : undefined;
  if (poolInfo.programId !== state.programId || poolInfo.mintA.address !== state.mintA || poolInfo.mintB.address !== state.mintB || poolKeys.vault.A !== state.vaultA || poolKeys.vault.B !== state.vaultB ||
    poolKeys.rewardInfos.length !== state.rewards.length || poolKeys.rewardInfos.some((reward, index) => reward.mint.address !== state.rewards[index]?.mint || reward.vault !== state.rewards[index]?.vault)) throw new Error("Compound pool or complete reward accounts have changed");
  const positionInfo = await connection.getAccountInfo(new PublicKey(state.positionAccount), "confirmed");
  if (!positionInfo || positionInfo.owner.toBase58() !== state.programId) throw new Error("Compound position does not exist");
  const ownerPosition = PersonalPositionLayout.decode(positionInfo.data);
  if (ownerPosition.nftMint.toBase58() !== positionMint || ownerPosition.poolId.toBase58() !== state.poolId || ownerPosition.tickLower !== state.tickLower || ownerPosition.tickUpper !== state.tickUpper || ownerPosition.liquidity.toString() !== state.liquidity) throw new Error("Compound position has changed");
  const ownerInfo = { wallet, tokenAccountA: new PublicKey(accounts[0].address), tokenAccountB: new PublicKey(accounts[1].address),
    rewardAccounts: state.rewards.map((reward) => new PublicKey(reward.mint === state.mintA ? accounts[0].address : reward.mint === state.mintB ? accounts[1].address : reward.account)) };
  const common = { poolInfo, poolKeys, ownerPosition, ownerInfo, nft2022: state.nftProgram === TOKEN_2022_PROGRAM_ID.toBase58() };
  const harvest = ClmmInstrument.decreaseLiquidityInstructions({ ...common, programId: new PublicKey(state.nftProgram), liquidity: new BN(0), amountMinA: new BN(0), amountMinB: new BN(0) });
  if (harvest.signers.length || harvest.instructions.length !== 1) throw new Error("Compound harvest instruction mismatch");
  // The SDK's RPC pool reader omits its API-only pool ALT. Include Raydium's
  // mainnet common ALT (from the installed SDK), freshly resolved through RPC.
  // Compilation only compresses exact instruction keys; no API controls writes.
  const tables = await readLookupTables(connection, [new PublicKey("AcL1Vo8oy1ULiavEcjSUcwfBSForXMudcZvDZy5nzJkU"),
    ...(poolTable && poolTable !== PublicKey.default.toBase58() ? [new PublicKey(poolTable)] : []),
    ...harvest.lookupTableAddress.map((address) => new PublicKey(address))]);
  if (tables.some((table) => !table.isActive())) throw new Error("Compound address lookup table is disabled");
  const simulationBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  const build = (instructions: TransactionInstruction[]) => new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: simulationBlockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...setup, ...instructions] }).compileToV0Message(tables));
  const tip = await fetchBeamTipAddress();
  const baseline = build(harvest.instructions);
  transactionSize(baseline);
  const fee = await connection.getFeeForMessage(baseline.message, "confirmed");
  if (fee.value === null) throw new Error("Unable to estimate compound network fee");
  const maxSolDebitLamports = BigInt(rentLamports + fee.value + 100_000 + (tip ? tip.lamports : 0));
  const simulate = (transaction: VersionedTransaction, expectedLiquidity: bigint) => simulateAndVerifyCompound({ connection, transaction, state,
    compoundAccounts: accounts, priorSources: prior.sources, expectedLiquidity, maxSolDebitLamports, sigVerify: false });
  const harvestResult = await simulate(baseline, 0n);
  if (harvestResult.rewards.some((reward) => BigInt(reward.amount) > 0n)) throw new Error("This position has a third reward token; no verifiable isolated swap path available; cannot fully reinvest, transaction not sent");
  const plan = await buildCompoundSwapPlan({ connection, state, accounts, poolInfo, poolKeys, computePoolInfo, tickData,
    amountA: BigInt(harvestResult.endingA), amountB: BigInt(harvestResult.endingB) });
  const swapInstructions = plan.instruction ? [plan.instruction] : [];
  const swapped = plan.instruction ? await simulate(build([...harvest.instructions, ...swapInstructions]), 0n) : harvestResult;
  const simulatedOutputAmount = plan.swap
    ? (plan.swap.outputMint === state.mintA ? BigInt(swapped.endingA) - BigInt(harvestResult.endingA)
      : BigInt(swapped.endingB) - BigInt(harvestResult.endingB)).toString() : undefined;
  const conservative = conservativeSwapBalances({
    endingA: BigInt(swapped.endingA), endingB: BigInt(swapped.endingB), mintA: state.mintA, mintB: state.mintB,
    swap: plan.swap ? { ...plan.swap, simulatedOutputAmount } : null,
  });
  const sized = sizeBufferedCompoundLiquidity(BigInt(swapped.sqrtPriceX64), BigInt(state.lowerSqrtX64), BigInt(state.upperSqrtX64),
    conservative.a, conservative.b, BigInt(state.liquidity));
  if (sized.liquidity === 0n) throw new Error("After yield swap still insufficient for minimum liquidity unit, cannot reinvest");
  const add = ClmmInstrument.increasePositionFromLiquidityInstructions({ ...common, liquidity: new BN(sized.liquidity.toString()),
    amountMaxA: new BN(sized.amountMaxA.toString()), amountMaxB: new BN(sized.amountMaxB.toString()) });
  if (add.signers.length || add.instructions.length !== 1) throw new Error("Compound increase instruction mismatch");
  validateCompoundRaydiumInstructions([...harvest.instructions, ...add.instructions], state, accounts, sized.liquidity, sized.amountMaxA, sized.amountMaxB);
  const withoutTip = build([...harvest.instructions, ...swapInstructions, ...add.instructions]);
  const withTip = tip
    ? build([...harvest.instructions, ...swapInstructions, ...add.instructions, beamTipInstruction(wallet, tip.address, tip.lamports)])
    : null;
  const chosen = chooseBeamTransaction(withoutTip, withTip);
  const simulated = chosen.transaction;
  const sizeBytes = transactionSize(simulated);
  const verified = await simulate(simulated, sized.liquidity);
  if (verified.rewards.some((reward) => BigInt(reward.amount) > 0n)) throw new Error("Simulation found unswapped third reward yield, cannot fully reinvest; please reprepare");
  const creditedPrior = (mint: string) => prior.sources.filter((source) => source.mint === mint).reduce((sum, source) => sum + BigInt(source.amount), 0n);
  const swap = plan.swap ? { ...plan.swap, sqrtPriceAfterX64: swapped.sqrtPriceX64, simulatedOutputAmount } : null;
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = restampVersionedTransaction(simulated, latest.blockhash, tables);
  const summary: CompoundSummary = { operation: "compound", simulated: true, state,
    positionMint, positionAccount: state.positionAccount, poolId: state.poolId, startingLiquidity: state.liquidity, liquidity: sized.liquidity.toString(),
    amountMaxA: sized.amountMaxA.toString(), amountMaxB: sized.amountMaxB.toString(), compoundAccounts: accounts,
    swaps: swap ? [swap] : [], priorSources: prior.sources,
    simulatedHarvest: { a: (BigInt(harvestResult.endingA) - creditedPrior(state.mintA)).toString(), b: (BigInt(harvestResult.endingB) - creditedPrior(state.mintB)).toString() }, simulatedRewards: verified.rewards,
    simulatedEndingLiquidity: verified.endingLiquidity, simulatedDustA: verified.endingA, simulatedDustB: verified.endingB,
    simulatedSolDebitLamports: verified.solDebitLamports, maxSolDebitLamports: maxSolDebitLamports.toString(),
    feeLamports: fee.value, rentLamports, sizeBytes, unitsConsumed: verified.unitsConsumed,
    beam: {
      included: chosen.included,
      tipLamports: chosen.included && tip ? tip.lamports : 0,
      tipAddress: chosen.included && tip ? tip.address.toBase58() : null,
      skippedReason: chosen.included ? null : chosen.skippedReason,
    },
    ...stampPreparedBlockhash(latest) };
  return { summary, transaction };
}

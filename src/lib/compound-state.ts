import "server-only";

import BN from "bn.js";
import { getPdaTickArrayAddress, LiquidityMathUtil, PersonalPositionLayout, PoolInfoLayout, PositionUtils, TickArrayLayout, TickArrayUtil, TickUtil } from "@raydium-io/raydium-sdk-v2";
import { AccountState, ExtensionType, getAssociatedTokenAddressSync, getDefaultAccountState, getExtensionTypes, getPausableConfig, getScaledUiAmountConfig, getTransferFeeConfig, getTransferHook, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount, unpackMint } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { NATIVE_SOL_MINT } from "./ids";
import { rpcConnection } from "./rpc";
import { readSelectedPositionState } from "./selected-state";
import { accruedFee, MAX_U64, wrappingSub128 } from "./compound-math";
import { positionSide } from "./quote-math";
import type { CompoundPositionState, CompoundReward } from "./compound-types";

const supported = new Set([
  ExtensionType.MintCloseAuthority, ExtensionType.PermanentDelegate, ExtensionType.PausableConfig,
  ExtensionType.MetadataPointer, ExtensionType.TokenMetadata, ExtensionType.GroupPointer,
  ExtensionType.TokenGroup, ExtensionType.GroupMemberPointer, ExtensionType.TokenGroupMember,
  ExtensionType.DefaultAccountState, ExtensionType.ConfidentialTransferMint,
  ExtensionType.TransferHook, ExtensionType.ScaledUiAmountConfig,
]);

export async function readCompoundPositionState(wallet: string, positionMint: string, connection: Connection = rpcConnection()): Promise<CompoundPositionState> {
  // Compound has no investment asset. The existing reader's allowEmptyInput path
  // retains its NFT/mint/vault checks without requiring an input token balance.
  const selected = await readSelectedPositionState(wallet, { positionMint, inputKind: "native", inputMint: NATIVE_SOL_MINT }, connection, true);
  const [positionInfo, poolInfo] = await connection.getMultipleAccountsInfo([
    new PublicKey(selected.positionAccount), new PublicKey(selected.poolId),
  ], "confirmed");
  if (!positionInfo || !poolInfo || positionInfo.owner.toBase58() !== selected.programId || poolInfo.owner.toBase58() !== selected.programId) throw new Error("Compound position or pool program mismatch");
  const position = PersonalPositionLayout.decode(positionInfo.data);
  const pool = PoolInfoLayout.decode(poolInfo.data);
  if (position.nftMint.toBase58() !== positionMint || position.poolId.toBase58() !== selected.poolId ||
    position.tickLower !== selected.tickLower || position.tickUpper !== selected.tickUpper || position.liquidity.toString() !== selected.liquidity ||
    pool.mintA.toBase58() !== selected.mintA || pool.mintB.toBase58() !== selected.mintB) throw new Error("Position or pool state has changed, please reload");
  // Price may move while the general reader checks wallet/mint accounts. Use
  // this newer pool snapshot for both fee growth and sizing instead of rejecting
  // every normally trading pool or pairing new fees with an older sqrt price.
  const rangeSide = positionSide(BigInt(pool.sqrtPriceX64.toString()), BigInt(selected.lowerSqrtX64), BigInt(selected.upperSqrtX64));
  const currentAmounts = LiquidityMathUtil.getAmountsForLiquidity(pool.sqrtPriceX64, new BN(selected.lowerSqrtX64), new BN(selected.upperSqrtX64), position.liquidity, true);
  const snapshot = { ...selected, sqrtPriceX64: pool.sqrtPriceX64.toString(), tickCurrent: pool.tickCurrent,
    price: TickUtil.sqrtPriceX64ToPrice(pool.sqrtPriceX64, selected.decimalsA, selected.decimalsB).toString(),
    poolLiquidity: pool.liquidity.toString(), rangeSide, inRange: rangeSide === "inside",
    currentAmounts: { a: currentAmounts.amountA.toString(), b: currentAmounts.amountB.toString() } };
  const ticks = [position.tickLower, position.tickUpper];
  const starts = ticks.map((tick) => TickArrayUtil.getTickArrayStartIndex(tick, pool.tickSpacing));
  const keys = starts.map((start) => getPdaTickArrayAddress(new PublicKey(selected.programId), new PublicKey(selected.poolId), start).publicKey);
  const infos = await connection.getMultipleAccountsInfo(keys, "confirmed");
  const boundaries = infos.map((info, index) => {
    if (!info || info.owner.toBase58() !== selected.programId) throw new Error("Compound boundary tick array does not exist");
    const array = TickArrayLayout.decode(info.data);
    if (array.poolId.toBase58() !== selected.poolId || array.startTickIndex !== starts[index]) throw new Error("Compound tick array does not match pool");
    const tick = array.ticks[TickArrayUtil.getTickOffsetInArray(ticks[index]!, pool.tickSpacing)];
    if (!tick || tick.tick !== ticks[index] || tick.liquidityGross.isZero()) throw new Error("Compound boundary tick not initialized");
    return tick;
  });
  const lower = boundaries[0]!;
  const upper = boundaries[1]!;
  const fee = (side: "A" | "B") => accruedFee({ tickCurrent: pool.tickCurrent, tickLower: position.tickLower, tickUpper: position.tickUpper,
    global: BigInt(pool[`feeGrowthGlobalX64${side}`].toString()), lowerOutside: BigInt(lower[`feeGrowthOutsideX64${side}`].toString()),
    upperOutside: BigInt(upper[`feeGrowthOutsideX64${side}`].toString()), lastInside: BigInt(position[`feeGrowthInsideLastX64${side}`].toString()),
    liquidity: BigInt(position.liquidity.toString()), owed: BigInt(position[`tokenFeesOwed${side}`].toString()) }).toString();
  const issues: string[] = [];
  if (!selected.ownsNft) issues.push("Wallet does not hold usable position NFT");
  if (!selected.sufficientSol) issues.push("Insufficient SOL to pay transaction and account rent");
  if (selected.paused || selected.frozen) issues.push("Pool assets are paused or frozen");
  if (selected.transferFee || selected.unsupportedExtensions.length) issues.push("Pool assets contain unsupported Token-2022 features");
  if (pool.status & 1) issues.push("Pool has disabled liquidity addition");
  if (pool.status & 4) issues.push("Pool has disabled fee collection");
  const slot = await connection.getSlot("confirmed");
  const chainTime = await connection.getBlockTime(slot);
  if (chainTime === null) throw new Error("Unable to read on-chain time to estimate rewards");
  const updatedRewards = pool.rewardInfos.map((reward) => {
    let growth = BigInt(reward.growthGlobalX64.toString());
    const time = Math.min(chainTime, reward.endTime.toNumber());
    const delta = Math.max(0, time - reward.lastUpdateTime.toNumber());
    const liquidity = BigInt(pool.liquidity.toString());
    if (!reward.mint.equals(PublicKey.default) && chainTime > reward.openTime.toNumber() && liquidity > 0n && delta > 0) {
      const emission = BigInt(delta) * BigInt(reward.emissionsPerSecondX64.toString());
      const emitted = (emission + (1n << 64n) - 1n) >> 64n;
      const remaining = MAX_U64 - BigInt(reward.totalEmissioned.toString());
      growth += emitted <= remaining ? emission / liquidity : remaining * (1n << 64n) / liquidity;
    }
    return { growthGlobalX64: new BN(wrappingSub128(growth, 0n).toString()) };
  });
  const estimatedRewards = PositionUtils.GetPositionRewards({ tickCurrent: pool.tickCurrent, rewardInfos: updatedRewards }, position, lower, upper);
  const rewards: CompoundReward[] = [];
  for (let index = 0; index < pool.rewardInfos.length; index++) {
    const reward = pool.rewardInfos[index]!;
    if (reward.mint.equals(PublicKey.default)) continue;
    const [mintInfo, vaultInfo] = await connection.getMultipleAccountsInfo([reward.mint, reward.vault], "confirmed");
    if (!mintInfo || !vaultInfo || ![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(mintInfo.owner.toBase58())) throw new Error("Reward mint or vault does not exist");
    const mint = unpackMint(reward.mint, mintInfo, mintInfo.owner);
    const vault = unpackAccount(reward.vault, vaultInfo, mintInfo.owner);
    if (!vault.mint.equals(reward.mint)) throw new Error("Reward vault mint mismatch");
    const extensions = getExtensionTypes(mint.tlvData);
    const feeConfig = getTransferFeeConfig(mint);
    const hook = getTransferHook(mint);
    const scaled = getScaledUiAmountConfig(mint);
    if (vault.isFrozen || getPausableConfig(mint)?.paused ||
      extensions.some((extension) => !supported.has(extension)) ||
      feeConfig && (feeConfig.olderTransferFee.transferFeeBasisPoints || feeConfig.newerTransferFee.transferFeeBasisPoints) ||
      hook && !hook.programId.equals(PublicKey.default) ||
      scaled && (scaled.multiplier !== 1 || scaled.newMultiplier !== 1) ||
      extensions.includes(ExtensionType.DefaultAccountState) && getDefaultAccountState(mint)?.state !== AccountState.Initialized) issues.push(`Reward ${reward.mint.toBase58()} contains unsupported or disabled token features`);
    const estimated = estimatedRewards[index]!;
    if (estimated.gt(new BN(MAX_U64.toString()))) throw new Error("Reward yield exceeds u64 range");
    rewards.push({ index, mint: reward.mint.toBase58(), vault: reward.vault.toBase58(), program: mintInfo.owner.toBase58(),
      decimals: mint.decimals, account: getAssociatedTokenAddressSync(reward.mint, new PublicKey(wallet), false, mintInfo.owner).toBase58(),
      estimatedAmount: estimated.toString(), compounded: reward.mint.toBase58() === selected.mintA || reward.mint.toBase58() === selected.mintB });
  }
  if (rewards.length && pool.status & 8) issues.push("Pool has disabled reward collection");
  return { ...snapshot, eligible: !issues.length, reason: issues.join("; ") || null, status: pool.status,
    vaultA: pool.vaultA.toBase58(), vaultB: pool.vaultB.toBase58(), tickSpacing: pool.tickSpacing,
    fees: { a: fee("A"), b: fee("B") }, rewards };
}

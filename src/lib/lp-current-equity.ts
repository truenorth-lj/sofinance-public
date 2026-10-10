import {CLMM_PROGRAM_ID,PersonalPositionLayout,PoolInfoLayout,TickArrayLayout,TickArrayUtil,getPdaTickArrayAddress,PositionUtils,LiquidityMathUtil,TickUtil} from "@raydium-io/raydium-sdk-v2";
import {PublicKey,SYSVAR_CLOCK_PUBKEY} from "@solana/web3.js";
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,unpackMint} from "@solana/spl-token";
import BN from "bn.js";
import {createHash} from "node:crypto";
type Pool=ReturnType<typeof PoolInfoLayout.decode>;
/** Same integer growth and emission cap as the installed Raydium SDK PoolUtil.
 * Preserve all three slot indices for PositionUtils.GetPositionRewards. */
export function rewardGlobalsAt(pool:Pool,chainTime:number){
 const max=(1n<<64n)-1n,q64=1n<<64n,L=BigInt(pool.liquidity.toString());
 return pool.rewardInfos.map(r=>{
  if(r.mint.equals(PublicKey.default)||BigInt(r.totalEmissioned.toString())===max||chainTime<=r.openTime.toNumber()||L===0n)return r;
  const delta=BigInt(Math.min(chainTime,r.endTime.toNumber()))-BigInt(r.lastUpdateTime.toString());
  if(delta<0n)throw new Error("Clock precedes reward update; snapshot invalid");
  const emission=BigInt(r.emissionsPerSecondX64.toString()),emitted=(delta*emission+q64-1n)/q64,remaining=max-BigInt(r.totalEmissioned.toString());
  const growth=emitted<=remaining?delta*emission/L:remaining*q64/L;
  return {...r,growthGlobalX64:r.growthGlobalX64.add(new BN(growth.toString()))};
 });
}
/** One RPC context for position, pool, boundary ticks, clock and reward mint
 * metadata. Pending amounts are gross inventory, not an executable exit quote. */
export async function readCurrentEquity(positionId:string,positionAccount:string,initial:Pool,initialPosition:ReturnType<typeof PersonalPositionLayout.decode>,rpc:(method:string,params:unknown[])=>Promise<unknown>){
 const ticks=[initialPosition.tickLower,initialPosition.tickUpper],starts=ticks.map(t=>TickArrayUtil.getTickArrayStartIndex(t,initial.tickSpacing));
 const poolId=initialPosition.poolId.toBase58(),rewardMints=initial.rewardInfos.filter(r=>!r.mint.equals(PublicKey.default)).map(r=>r.mint.toBase58());
 const addresses=[positionAccount,poolId,...starts.map(s=>getPdaTickArrayAddress(CLMM_PROGRAM_ID,new PublicKey(poolId),s).publicKey.toBase58()),SYSVAR_CLOCK_PUBKEY.toBase58(),...rewardMints];
 type Account={owner:string;data:[string,string];lamports:number;executable:boolean;rentEpoch:number};
 const response=await rpc("getMultipleAccounts",[addresses,{encoding:"base64",commitment:"confirmed"}]) as {context:{slot:number};value:(Account|null)[]};
 const data=(index:number,name?:string)=>{const a=response.value[index];if(!a)throw new Error("Snapshot account missing");const b=Buffer.from(a.data[0],"base64");if(name&&(a.owner!==CLMM_PROGRAM_ID.toBase58()||!b.subarray(0,8).equals(createHash("sha256").update(`account:${name}`).digest().subarray(0,8))))throw new Error("Snapshot account identity invalid");return b;};
 const position=PersonalPositionLayout.decode(data(0,"PersonalPositionState")),pool=PoolInfoLayout.decode(data(1,"PoolState"));
 if(position.nftMint.toBase58()!==positionId||position.poolId.toBase58()!==poolId||position.tickLower!==ticks[0]||position.tickUpper!==ticks[1]||pool.rewardInfos.filter(r=>!r.mint.equals(PublicKey.default)).map(r=>r.mint.toBase58()).join()!==rewardMints.join())throw new Error("Snapshot context changed; retry");
 const boundaries=starts.map((start,i)=>{const array=TickArrayLayout.decode(data(i+2,"TickArrayState"));if(array.poolId.toBase58()!==poolId||array.startTickIndex!==start)throw new Error("Tick array context mismatch");const tick=array.ticks[TickArrayUtil.getTickOffsetInArray(ticks[i]!,pool.tickSpacing)];if(!tick||tick.tick!==ticks[i])throw new Error("Boundary tick unavailable");return tick;});
 const clock=data(4),chainTime=Number(clock.readBigInt64LE(32));if(!Number.isSafeInteger(chainTime)||Math.abs(Date.now()/1000-chainTime)>60)throw new Error("Chain clock stale");
 const fees=PositionUtils.GetPositionFees(pool,position,boundaries[0]!,boundaries[1]!),rewardAmounts=PositionUtils.GetPositionRewards({...pool,rewardInfos:rewardGlobalsAt(pool,chainTime)},position,boundaries[0]!,boundaries[1]!);
 const amounts=LiquidityMathUtil.getAmountsForLiquidity(pool.sqrtPriceX64,TickUtil.getSqrtPriceAtTick(position.tickLower),TickUtil.getSqrtPriceAtTick(position.tickUpper),position.liquidity,false);
 const equity=[{mint:pool.mintA.toBase58(),decimals:pool.mintDecimalsA,amountAtomic:amounts.amountA.add(fees.tokenFeeAmountA).toString()},{mint:pool.mintB.toBase58(),decimals:pool.mintDecimalsB,amountAtomic:amounts.amountB.add(fees.tokenFeeAmountB).toString()}];
 for(const [i,r] of pool.rewardInfos.entries()){if(r.mint.equals(PublicKey.default)){if(!rewardAmounts[i]!.isZero())throw new Error("Uninitialized reward slot has owed inventory");continue;}const index=5+rewardMints.indexOf(r.mint.toBase58()),a=response.value[index]!;if(![TOKEN_PROGRAM_ID.toBase58(),TOKEN_2022_PROGRAM_ID.toBase58()].includes(a.owner))throw new Error("Reward mint owner invalid");const mint=unpackMint(r.mint,{...a,data:data(index),owner:new PublicKey(a.owner)},new PublicKey(a.owner));equity.push({mint:r.mint.toBase58(),decimals:mint.decimals,amountAtomic:rewardAmounts[i]!.toString()});}
 return {equity,liquidity:position.liquidity.toString(),slot:response.context.slot,chainTime,basis:"Single confirmed RPC context: liquidity principal + boundary-tick fee accrual + time-adjusted reward inventory; reference valuation, not executable exit"};
}

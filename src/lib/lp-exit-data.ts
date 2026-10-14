import "server-only";
import { verifiedTokenAmount,cleanExitDeltas } from "./lp-exit-verification";
import BN from "bn.js";
import { createHash } from "node:crypto";
import { CLMM_PROGRAM_ID, ClmmInstrument, PersonalPositionLayout, PoolInfoLayout, getPdaPersonalPositionAddress, getPdaProtocolPositionAddress, getPdaTickArrayAddress, getPdaExBitmapAccount, TickArrayUtil } from "@raydium-io/raydium-sdk-v2";
import { PublicKey, TransactionMessage, VersionedTransaction, type AccountInfo } from "@solana/web3.js";
import { withCacheAndInflight } from "./rpc/cache";
import { PREVIEW_RETRY } from "./rpc/retry";
import { rpcConnection, type RpcEnv } from "./rpc";
import { unpackMint, unpackAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { compactAtaInstructions, compileCompactOpenTransaction, openLookupTableReader, versionedTransactionSize } from "./open-transaction";
import { instruction } from "./transaction-helpers";
import { EXIT_JUPITER_CONCURRENCY, mapPool } from "./jupiter";
import { buildExitSwapLeg, type ExitSwapRoute } from "./swap/exit";
import { atomicComputeUnitLimitInstruction, exceedsTxSizeLimit } from "./transaction-limits";
const USDC="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",SOL="So11111111111111111111111111111111111111112";
export const EXIT_PREVIEW_TTL_MS=8_000;
export function exitPreviewCacheKey(positionId:string,nftAccount?:string,convertRent=true){return `exit-preview:${positionId}:${nftAccount??""}:${convertRent?"1":"0"}`;}
function checked(info:AccountInfo<Buffer>|null,name:string){if(!info||!info.owner.equals(CLMM_PROGRAM_ID)||!info.data.subarray(0,8).equals(createHash("sha256").update(`account:${name}`).digest().subarray(0,8)))throw new Error(`${name} account invalid`);return info.data;}
export async function coalesceExitPreview<T>(positionId:string,nftAccount:string|undefined,convertRent:boolean,run:()=>Promise<T>){
 const {value}=await withCacheAndInflight(exitPreviewCacheKey(positionId,nftAccount,convertRent),EXIT_PREVIEW_TTL_MS,run);
 return value;
}
export async function readFullExitPreview(positionId:string,nftAccount?:string,convertRent=true,fetcher:typeof fetch=fetch,signal?:AbortSignal){
 return coalesceExitPreview(positionId,nftAccount,convertRent,()=>readFullExitPreviewUnlocked(positionId,nftAccount,convertRent,fetcher,signal));
}
async function readFullExitPreviewUnlocked(positionId:string,nftAccount?:string,convertRent=true,fetcher:typeof fetch=fetch,signal?:AbortSignal){
 const budget=AbortSignal.any([AbortSignal.timeout(90000),...(signal?[signal]:[])]);
 const connection=rpcConnection(process.env as RpcEnv,{fetch:fetcher,signal:budget,retry:PREVIEW_RETRY});
 const positionKey=getPdaPersonalPositionAddress(CLMM_PROGRAM_ID,new PublicKey(positionId)).publicKey;
 const position=PersonalPositionLayout.decode(checked(await connection.getAccountInfo(positionKey),"PersonalPositionState"));
 if(position.nftMint.toBase58()!==positionId)throw new Error("NFT context mismatch");
 const [poolInfo,largest]=await Promise.all([
  connection.getAccountInfo(position.poolId),
  nftAccount?Promise.resolve(null):connection.getTokenLargestAccounts(position.nftMint),
 ]);
 const pool=PoolInfoLayout.decode(checked(poolInfo,"PoolState"));
 const nftKey=nftAccount?new PublicKey(nftAccount):new PublicKey(largest?.value.find(v=>v.amount==="1")?.address??"");
 const rewards=pool.rewardInfos.filter(r=>!r.mint.equals(PublicKey.default)),mints=[pool.mintA,pool.mintB,...rewards.map(r=>r.mint)];
 if(mints.some(m=>m.toBase58()===USDC))throw new Error("Direct-USDC pool/reward accounting is not supported by this exit preview");
 const [nftRaw,...mintInfos]=await connection.getMultipleAccountsInfo([nftKey,...mints]);
 if(!nftRaw||![TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].some(p=>p.equals(nftRaw.owner)))throw new Error("NFT account missing/token program invalid");
 const nft=unpackAccount(nftKey,nftRaw,nftRaw.owner);
 if(!nft.mint.equals(position.nftMint)||nft.amount!==1n||nft.isFrozen)throw new Error("NFT owner/mint/amount not usable");
 const owner=nft.owner;
 const programs=mintInfos.map(i=>{if(!i||![TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].some(p=>p.equals(i.owner)))throw new Error("Pool/reward mint program invalid");return i.owner;});
 const recipients=mints.map((m,i)=>getAssociatedTokenAddressSync(m,owner,false,programs[i]));
 const addresses=[owner,positionKey,nftKey,position.nftMint,...recipients],before=await connection.getMultipleAccountsInfoAndContext(addresses);
 const setup=recipients.flatMap((a,i)=>before.value[i+4]?[]:[createAssociatedTokenAccountIdempotentInstruction(owner,a,owner,mints[i]!,programs[i])]);
 const tick=(value:number)=>getPdaTickArrayAddress(CLMM_PROGRAM_ID,position.poolId,TickArrayUtil.getTickArrayStartIndex(value,pool.tickSpacing)).publicKey;
 const withdraw=ClmmInstrument.decreaseLiquidityV2Instruction(CLMM_PROGRAM_ID,owner,nftKey,positionKey,position.poolId,getPdaProtocolPositionAddress(CLMM_PROGRAM_ID,position.poolId,position.tickLower,position.tickUpper).publicKey,tick(position.tickLower),tick(position.tickUpper),recipients[0]!,recipients[1]!,pool.vaultA,pool.vaultB,pool.mintA,pool.mintB,rewards.map((r,i)=>({poolRewardVault:r.vault,ownerRewardVault:recipients[i+2]!,rewardMint:r.mint})),position.liquidity,new BN(0),new BN(0),getPdaExBitmapAccount(CLMM_PROGRAM_ID,position.poolId).publicKey);
 const close=ClmmInstrument.closePositionInstruction(CLMM_PROGRAM_ID,owner,position.nftMint,nftKey,positionKey,nftRaw.owner.equals(TOKEN_2022_PROGRAM_ID),position.poolId);
 const blockhash=await connection.getLatestBlockhash();
 const prefix=[atomicComputeUnitLimitInstruction(),...setup,withdraw,close];
 const baseline=new VersionedTransaction(new TransactionMessage({payerKey:owner,recentBlockhash:blockhash.blockhash,instructions:prefix}).compileToV0Message());
 if(exceedsTxSizeLimit(versionedTransactionSize(baseline)))throw new Error("Withdrawal/close packet size exceeded");
 const withdrawSimulation=await connection.simulateTransaction(baseline,{sigVerify:false,replaceRecentBlockhash:true,minContextSlot:before.context.slot,accounts:{encoding:"base64",addresses:addresses.map(a=>a.toBase58())}});
 if(withdrawSimulation.value.err||!withdrawSimulation.value.accounts)throw new Error(`Withdrawal simulation failed: ${JSON.stringify(withdrawSimulation.value.err)}`);

 const received=mints.map((mint,i)=>{const after=withdrawSimulation.value.accounts![i+4],prior=before.value[i+4];if(!after)throw new Error("Simulation recipient missing");const amount=verifiedTokenAmount(after.data[0],owner,mint,after.owner)-(prior?prior.data.readBigUInt64LE(64):0n);if(amount<0n)throw new Error("Withdrawal consumed wallet inventory");return {mint:mint.toBase58(),amountAtomic:amount.toString()};});
 const routes:ExitSwapRoute[]=[],quotes:{mint:string;inputAtomic:string;feeAmount:string;outputUSDCAtomic:string;thresholdUSDCAtomic:string;observedAt:string}[]=[];
 const ownerBefore=before.value[0];if(!ownerBefore)throw new Error("Owner SOL account missing");
 const netSOL=BigInt(withdrawSimulation.value.accounts[0]!.lamports)-BigInt(ownerBefore.lamports);
 const legs=[...received.map(leg=>({...leg,native:false})),...(convertRent&&netSOL>0n?[{mint:SOL,amountAtomic:netSOL.toString(),native:true}]:[])].filter(v=>BigInt(v.amountAtomic)>0n);
 const feeInstructions: import("@solana/web3.js").TransactionInstruction[]=[];
 const quoted=await mapPool(legs,EXIT_JUPITER_CONCURRENCY,async(leg)=>{
  const index=mints.findIndex(m=>m.toBase58()===leg.mint),program=index>=0?programs[index]!:TOKEN_PROGRAM_ID;
  return buildExitSwapLeg({connection,owner,mint:new PublicKey(leg.mint),program,
    source:index>=0?recipients[index]:undefined,
    decimals:index>=0?unpackMint(new PublicKey(leg.mint),mintInfos[index]!,program).decimals:9,
    amount:BigInt(leg.amountAtomic),native:leg.native,signal:budget,fetcher});
 });
 for(const item of quoted){routes.push(item.route);feeInstructions.push(...item.fee);quotes.push(item.quote);}
 const tableKeys=[...new Set(["AcL1Vo8oy1ULiavEcjSUcwfBSForXMudcZvDZy5nzJkU",...routes.flatMap(r=>r.addressLookupTableAddresses)])];
 const tables=await openLookupTableReader(connection)(tableKeys.map(k=>new PublicKey(k)));
 const instructions=await compactAtaInstructions(connection,[...prefix,...feeInstructions,...routes.flatMap(r=>[...(r.setupInstructions??[]),...(r.otherInstructions??[]),r.swapInstruction,...(r.cleanupInstruction?[r.cleanupInstruction]:[])].map(v=>instruction(v,owner)))]);
 const compiled=compileCompactOpenTransaction({payerKey:owner,recentBlockhash:blockhash.blockhash,instructions},tables),bytes=versionedTransactionSize(compiled.transaction);
 if(exceedsTxSizeLimit(bytes))return {status:"unavailable",reason:`Full atomic exit exceeds 1232 bytes: ${bytes}`,bytes,convertRent,received,quotes,netRecoveryUSDC:null,executable:false,sent:false};
 const usdcAta=getAssociatedTokenAddressSync(new PublicKey(USDC),owner),finalAddresses=[...addresses,usdcAta];
 const usdcInfo=await connection.getAccountInfo(usdcAta);
 const finalBefore={context:before.context,value:[...before.value,usdcInfo]};
 const fee=(await connection.getFeeForMessage(compiled.transaction.message)).value;
 const simulation=await connection.simulateTransaction(compiled.transaction,{sigVerify:false,replaceRecentBlockhash:true,minContextSlot:before.context.slot,accounts:{encoding:"base64",addresses:finalAddresses.map(a=>a.toBase58())}});
 if(simulation.value.err||!simulation.value.accounts)throw new Error(`Combined exit simulation failed: ${JSON.stringify(simulation.value.err)}`);
 const actual=simulation.value.accounts;
 const tokenDeltas=recipients.map((_,i)=>{const prior=finalBefore.value[i+4];if(!actual[i+4])throw new Error("Final recipient missing");return (verifiedTokenAmount(actual[i+4]!.data[0],owner,mints[i]!,actual[i+4]!.owner)-(prior?prior.data.readBigUInt64LE(64):0n)).toString();});
 const usdcBefore=finalBefore.value.at(-1),usdcAfter=actual.at(-1);if(!usdcAfter)throw new Error("Final USDC account missing");
 const usdc=verifiedTokenAmount(usdcAfter.data[0],owner,new PublicKey(USDC),usdcAfter.owner)-(usdcBefore?usdcBefore.data.readBigUInt64LE(64):0n);
 const nativeDelta=BigInt(actual[0]!.lamports)-BigInt(finalBefore.value[0]!.lamports);
 const clean=cleanExitDeltas(tokenDeltas,nativeDelta,[1,2,3].map(i=>actual[i]?.lamports),convertRent)&&usdc>=0n;
 const observedAt=new Date().toISOString(),expiresAt=Math.min(Date.now(),...quotes.map(q=>Date.parse(q.observedAt)))+15000,fresh=Date.now()<expiresAt;
 return {status:clean&&fresh?"verified-preview":"partial",source:"RPC unsigned simulation + Jupiter routes",observedAt,localExpiresAt:new Date(expiresAt).toISOString(),expirySource:"local 15-second refresh policy, not provider guarantee",lastValidBlockHeight:blockhash.lastValidBlockHeight,slot:simulation.context.slot,bytes,convertRent,received,quotes,recoveryUSDCAtomic:usdc.toString(),recoverySOLLamports:nativeDelta.toString(),remainingTokenDeltas:tokenDeltas,networkAndPriorityLamports:fee===null?null:String(fee),priorityPolicy:"explicit zero CU price; landing not guaranteed",netRecoveryUSDC:clean&&fresh&&convertRent&&fee!==null?usdc.toString():null,executable:false,sent:false};
}

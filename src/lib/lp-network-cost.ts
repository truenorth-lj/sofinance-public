import bs58 from "bs58";
import type { PublicTransaction } from "./lp-position-observations";
/** Fee paid is authoritative. Priority is based on requested CU, never consumed CU. */
export function observedNetworkCost(tx:PublicTransaction){
 const fee=tx.meta?.fee;if(!Number.isSafeInteger(fee)||fee!<0)return {totalLamports:null,networkLamports:null,priorityLamports:null};
 const total=BigInt(fee!),unknown={totalLamports:total.toString(),networkLamports:null,priorityLamports:null};
 let limit:bigint|undefined,price=0n,sawPrice=false;
 try{for(const ix of tx.transaction?.message.instructions??[]){if(ix.programId!=="ComputeBudget111111111111111111111111111111")continue;
  if(!ix.data)return unknown;const data=Buffer.from(bs58.decode(ix.data));
  if(data[0]===2&&data.length===5&&limit===undefined)limit=BigInt(data.readUInt32LE(1));
  else if(data[0]===3&&data.length===9&&!sawPrice){price=data.readBigUInt64LE(1);sawPrice=true;}
  else return unknown;
 }}catch{return unknown;}
 if(price>0n&&limit===undefined)return unknown;
 const priority=((limit??0n)*price+999999n)/1000000n;
 if(priority>total)return unknown;
 return {totalLamports:total.toString(),networkLamports:(total-priority).toString(),priorityLamports:priority.toString()};
}
/** Only the NFT account refund is attributed; mixed batch fees need a policy. */
export function observedNftRentRefund(signature:string,tx:PublicTransaction,nftAccount:string,positionId:string){
 const keys=tx.transaction?.message.accountKeys??[],index=keys.findIndex(k=>(typeof k==="string"?k:k.pubkey)===nftAccount);
 const pre=tx.meta?.preBalances?.[index],post=tx.meta?.postBalances?.[index];
 const refundInstruction=tx.transaction?.message.instructions?.filter(i=>i.programId==="TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"&&i.parsed?.type==="withdrawExcessLamports"&&i.parsed.info.source===nftAccount);
 const balances=[...(tx.meta?.preTokenBalances??[]),...(tx.meta?.postTokenBalances??[])].filter(b=>b.accountIndex===index&&b.mint===positionId&&b.uiTokenAmount.amount==="1"&&b.owner===refundInstruction?.[0]?.parsed?.info.destination);
 const proven=balances.length===2&&refundInstruction?.length===1&&refundInstruction[0]!.parsed!.info.destination===refundInstruction[0]!.parsed!.info.authority&&!tx.meta?.err&&index>=0&&Number.isSafeInteger(pre)&&Number.isSafeInteger(post)&&pre!>=post!;
 return {signature,nftAccount,refundLamports:proven?(BigInt(pre!)-BigInt(post!)).toString():null,transactionCost:observedNetworkCost(tx),positionFeeAllocationLamports:null,mixedBatch:true,scope:"NFT account lamport change only"};
}

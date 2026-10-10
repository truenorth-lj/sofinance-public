// Public task-scoped read/simulation probes. No signer, keys or sendTransaction.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import BN from 'bn.js';
import { CLMM_PROGRAM_ID, ClmmInstrument, PersonalPositionLayout, PoolInfoLayout, getPdaPersonalPositionAddress, getPdaProtocolPositionAddress, getPdaTickArrayAddress, getPdaExBitmapAccount, TickArrayUtil } from '@raydium-io/raydium-sdk-v2';
import { PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, TransactionInstruction } from '@solana/web3.js';
import { unpackAccount, getAssociatedTokenAddressSync } from '@solana/spl-token';
const dir=new URL('../specs/lp-decision/fixtures/closure/',import.meta.url), rpc='https://api.mainnet-beta.solana.com';
const selected=JSON.parse(await readFile(new URL('../specs/lp-decision/fixtures/selected-public-position.json',import.meta.url),'utf8'));
const attempts=[];
async function call(name,url,body){const observedAt=new Date().toISOString();try{const r=await fetch(url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});const text=await r.text();let value;try{value=JSON.parse(text);}catch{value={text:text.slice(0,1000)}}await writeFile(new URL(name+'.json',dir),JSON.stringify(value,null,2));attempts.push({name,url,observedAt,status:r.status,sha256:createHash('sha256').update(JSON.stringify(value,null,2)).digest('hex'),error:value.error??null});console.log(name,r.status,value.error??'received');return value;}catch(e){attempts.push({name,url,observedAt,error:e.message});console.log(name,e.message);return null;}}
const rpcCall=(name,method,params)=>call(name,rpc,{jsonrpc:'2.0',id:1,method,params});
if(process.argv.includes('--related-history')){
 const evidence=JSON.parse(await readFile(new URL('../specs/lp-decision/fixtures/public-transaction-evidence.json',import.meta.url),'utf8'));
 const nftAccount=evidence.transactions.flatMap(t=>t.tokenBalances).find(b=>b.mint===selected.positionMint&&b.postAtomic==='1').account;
 const known=new Set(evidence.transactions.map(t=>t.signature)),additional=new Set();
 for(const [name,address] of [['mint',selected.positionMint],['nft-account',nftAccount]]){
  const data=await rpcCall('related-signatures-'+name,'getSignaturesForAddress',[address,{limit:100,commitment:'confirmed'}]);
  for(const item of data?.result??[])if(!known.has(item.signature))additional.add(item.signature);
 }
 for(const signature of additional){await new Promise(resolve=>setTimeout(resolve,1300));const data=await rpcCall('related-tx-'+signature,'getTransaction',[signature,{encoding:'jsonParsed',commitment:'confirmed',maxSupportedTransactionVersion:0}]);if(data?.error?.code===429)break;}
 await writeFile(new URL('related-history-attempts.json',dir),JSON.stringify({attempts,additionalSignatures:[...additional],scope:'NFT mint/account only; no wallet-wide discovery'},null,2));
}else if(process.argv.includes('--prices')){
 const sigs=JSON.parse(await readFile(new URL('../specs/lp-decision/fixtures/rpc-position-signatures.json',import.meta.url),'utf8')).result;
 const oldest=Math.min(...sigs.map(s=>s.blockTime).filter(Boolean));
 const tokens=[['a','SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb'],['b','Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8'],['ray','4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'],['sol','So11111111111111111111111111111111111111112']];
 const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
 for(const [label,mint] of tokens){
  if(process.argv.includes('--resume-prices')){try{const old=JSON.parse(await readFile(new URL('historical-minute-usdc-'+label+'.json',dir),'utf8'));if(old.data?.attributes?.ohlcv_list?.length)continue;}catch{}}
  let cached;try{cached=JSON.parse(await readFile(new URL('historical-pools-'+label+'.json',dir),'utf8'));}catch{}
  const value=cached?.data?.length?cached:await call('historical-pools-'+label,`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?page=1`);
  const pair=value?.data?.find(p=>p.relationships?.base_token?.data?.id==='solana_'+USDC||p.relationships?.quote_token?.data?.id==='solana_'+USDC);
  if(pair){const base=pair.relationships.base_token.data.id==='solana_'+mint;await call('historical-minute-usdc-'+label,`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pair.attributes.address}/ohlcv/minute?aggregate=1&limit=1000&before_timestamp=${oldest+60}&currency=token&token=${base?'base':'quote'}`);}
  await new Promise(resolve=>setTimeout(resolve,2100));
 }
}else{
 try{
 const values=await rpcCall('exit-accounts','getMultipleAccounts',[[selected.positionAccount,selected.poolId],{encoding:'base64',commitment:'confirmed'}]);
 const raw=values.result.value;const position=PersonalPositionLayout.decode(Buffer.from(raw[0].data[0],'base64')),pool=PoolInfoLayout.decode(Buffer.from(raw[1].data[0],'base64'));
 if(raw.some(a=>a.owner!==CLMM_PROGRAM_ID.toBase58())||position.nftMint.toBase58()!==selected.positionMint||position.poolId.toBase58()!==selected.poolId)throw new Error('Position ownership/context mismatch');
 const largest=await rpcCall('exit-nft-accounts','getTokenLargestAccounts',[selected.positionMint,{commitment:'confirmed'}]);
 let nftAddress=largest?.result?.value?.find(a=>a.amount==='1')?.address;
 if(!nftAddress){const prior=JSON.parse(await readFile(new URL('../specs/lp-decision/fixtures/public-transaction-evidence.json',import.meta.url),'utf8'));nftAddress=prior.transactions.flatMap(t=>t.tokenBalances).find(b=>b.mint===selected.positionMint&&b.postAtomic==='1')?.account;}
 if(!nftAddress)throw new Error('NFT account unavailable; no current ownership claim');
 const nftKey=new PublicKey(nftAddress);
 const nftData=await rpcCall('exit-nft-account','getAccountInfo',[nftKey.toBase58(),{encoding:'base64',commitment:'confirmed'}]);
 const nftRaw=nftData.result.value,nft=unpackAccount(nftKey,{...nftRaw,data:Buffer.from(nftRaw.data[0],'base64'),owner:new PublicKey(nftRaw.owner)},new PublicKey(nftRaw.owner));
 if(nft.mint.toBase58()!==selected.positionMint||nft.amount!==1n||nft.isFrozen)throw new Error('Current NFT token account does not hold usable target NFT');
 const owner=nft.owner;
 const mints=[pool.mintA,pool.mintB,...pool.rewardInfos.filter(r=>!r.mint.equals(PublicKey.default)).map(r=>r.mint)];
 const mintData=await rpcCall('exit-mints','getMultipleAccounts',[mints.map(m=>m.toBase58()),{encoding:'base64',commitment:'confirmed'}]);
 const tokenPrograms=mintData.result.value.map(a=>new PublicKey(a.owner));
 const recipients=mints.map((m,i)=>getAssociatedTokenAddressSync(m,owner,false,tokenPrograms[i]));
 const before=await rpcCall('exit-recipients-before','getMultipleAccounts',[[owner.toBase58(),selected.positionAccount,nftKey.toBase58(),selected.positionMint,...recipients.map(k=>k.toBase58())],{encoding:'base64',commitment:'confirmed'}]);
 const tick=(t)=>getPdaTickArrayAddress(CLMM_PROGRAM_ID,new PublicKey(selected.poolId),TickArrayUtil.getTickArrayStartIndex(t,pool.tickSpacing)).publicKey;
 const rewards=pool.rewardInfos.filter(r=>!r.mint.equals(PublicKey.default)).map((r,i)=>({poolRewardVault:r.vault,ownerRewardVault:recipients[i+2],rewardMint:r.mint}));
 const withdraw=ClmmInstrument.decreaseLiquidityV2Instruction(CLMM_PROGRAM_ID,owner,nftKey,new PublicKey(selected.positionAccount),new PublicKey(selected.poolId),getPdaProtocolPositionAddress(CLMM_PROGRAM_ID,new PublicKey(selected.poolId),position.tickLower,position.tickUpper).publicKey,tick(position.tickLower),tick(position.tickUpper),recipients[0],recipients[1],pool.vaultA,pool.vaultB,pool.mintA,pool.mintB,rewards,position.liquidity,new BN(0),new BN(0),getPdaExBitmapAccount(CLMM_PROGRAM_ID,new PublicKey(selected.poolId)).publicKey);
 const close=ClmmInstrument.closePositionInstruction(CLMM_PROGRAM_ID,owner,position.nftMint,nftKey,new PublicKey(selected.positionAccount),nftRaw.owner==='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',new PublicKey(selected.poolId));
 const hash=await rpcCall('exit-blockhash','getLatestBlockhash',[{commitment:'confirmed'}]);
 const message=new TransactionMessage({payerKey:owner,recentBlockhash:hash.result.value.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),withdraw,close]}).compileToV0Message();
 const tx=new VersionedTransaction(message);const serialized=tx.serialize();
 const fee=await rpcCall('exit-network-fee','getFeeForMessage',[Buffer.from(message.serialize()).toString('base64'),{commitment:'confirmed'}]);
 const addresses=[owner.toBase58(),selected.positionAccount,nftKey.toBase58(),selected.positionMint,...recipients.map(k=>k.toBase58())];
 await writeFile(new URL('exit-simulation-context.json',dir),JSON.stringify({position:selected,owner:owner.toBase58(),mints:mints.map(k=>k.toBase58()),recipients:recipients.map(k=>k.toBase58()),addresses,serializedBytes:serialized.length,networkFeeLamports:fee?.result?.value,signatureVerification:false,sent:false,beforeContextSlot:before?.result?.context?.slot},null,2));
 if(serialized.length>1232)throw new Error('Withdrawal+close exceeds packet limit');
 const simulation=await rpcCall('exit-withdraw-close-simulation','simulateTransaction',[Buffer.from(serialized).toString('base64'),{encoding:'base64',sigVerify:false,replaceRecentBlockhash:true,commitment:'confirmed',accounts:{encoding:'base64',addresses},innerInstructions:true}]);
 if(simulation?.result?.value?.err)throw new Error('Withdrawal simulation failed: '+JSON.stringify(simulation.result.value.err));
 const received=[]; const routes=[];
 for(let i=0;i<mints.length;i++){
   const prior=before.result.value[i+4],after=simulation.result.value.accounts[i+4];
   if(!prior||!after)throw new Error('Recipient pre/post account missing');
   const amount=Buffer.from(after.data[0],'base64').readBigUInt64LE(64)-Buffer.from(prior.data[0],'base64').readBigUInt64LE(64);
   if(amount<0n)throw new Error('Withdrawal unexpectedly consumed wallet tokens');
   received.push({mint:mints[i].toBase58(),amountAtomic:amount.toString()});
   if(amount===0n)continue;
   const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
   const quote=await call('exit-received-quote-'+i,`https://api.jup.ag/swap/v1/quote?inputMint=${mints[i].toBase58()}&outputMint=${USDC}&amount=${amount}&slippageBps=50${process.argv.includes('--compact-routes')?'&maxAccounts=20&onlyDirectRoutes=true':''}`);
   await new Promise(resolve=>setTimeout(resolve,1300));
   const route=await call('exit-swap-instructions-'+i,'https://api.jup.ag/swap/v1/swap-instructions',{userPublicKey:owner.toBase58(),quoteResponse:quote,wrapAndUnwrapSol:true,dynamicComputeUnitLimit:false,prioritizationFeeLamports:0});
   if(!route?.swapInstruction)throw new Error("Jupiter unsigned route missing: "+JSON.stringify(route?.error??route));
   routes.push(route);
 }
 if(process.argv.includes('--convert-rent')) {
   const nativeDelta=BigInt(simulation.result.value.accounts[0].lamports)-BigInt(before.result.value[0].lamports);
   if(nativeDelta<=0n)throw new Error('No positive net rent refund available to convert');
   const quote=await call('exit-net-rent-sol-quote','https://api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount='+nativeDelta+'&slippageBps=50&maxAccounts=20&onlyDirectRoutes=true');
   await new Promise(resolve=>setTimeout(resolve,1300));
   const route=await call('exit-net-rent-sol-instructions','https://api.jup.ag/swap/v1/swap-instructions',{userPublicKey:owner.toBase58(),quoteResponse:quote,wrapAndUnwrapSol:true,dynamicComputeUnitLimit:false,prioritizationFeeLamports:0});
   if(!route?.swapInstruction)throw new Error('SOL rent conversion route unavailable');
   routes.push(route);
 }
 if(process.argv.includes('--combined')) {
   const {compileCompactOpenTransaction,versionedTransactionSize}=await import('../src/lib/open-transaction.ts');
   const {AddressLookupTableAccount,AddressLookupTableProgram}=await import('@solana/web3.js');
   const tableKeys=[...new Set(['AcL1Vo8oy1ULiavEcjSUcwfBSForXMudcZvDZy5nzJkU',...routes.flatMap(r=>r.addressLookupTableAddresses)])];
   const infos=await rpcCall('exit-combined-alts','getMultipleAccounts',[tableKeys,{encoding:'base64',commitment:'confirmed'}]);
   const tables=infos.result.value.map((v,i)=>{if(!v||v.owner!==AddressLookupTableProgram.programId.toBase58())throw new Error('Invalid ALT owner');const t=new AddressLookupTableAccount({key:new PublicKey(tableKeys[i]),state:AddressLookupTableAccount.deserialize(Buffer.from(v.data[0],'base64'))});if(!t.isActive())throw new Error('Inactive ALT');return t;});
   const ix=(v)=>{if(v.accounts.some(a=>a.isSigner&&a.pubkey!==owner.toBase58()))throw new Error('Unexpected route signer');return new TransactionInstruction({programId:new PublicKey(v.programId),keys:v.accounts.map(a=>({pubkey:new PublicKey(a.pubkey),isSigner:a.isSigner,isWritable:a.isWritable})),data:Buffer.from(v.data,'base64')});};
   const instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),withdraw,close,...routes.flatMap(r=>[...(r.setupInstructions??[]),...(r.otherInstructions??[]),r.swapInstruction,...(r.cleanupInstruction?[r.cleanupInstruction]:[])].map(ix))];
   const compiled=compileCompactOpenTransaction({payerKey:owner,recentBlockhash:hash.result.value.blockhash,instructions},tables);
   const bytes=versionedTransactionSize(compiled.transaction);
   await writeFile(new URL('exit-combined-size.json',dir),JSON.stringify({bytes,limit:1232,instructions:instructions.length,tables:compiled.tables.map(t=>t.key.toBase58()),sent:false},null,2));
   if(bytes>1232)throw new Error(`Atomic full exit exceeds packet limit: ${bytes} > 1232`);
   const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',usdcAta=getAssociatedTokenAddressSync(new PublicKey(USDC),owner).toBase58();
   const finalAddresses=[...addresses,usdcAta];
   await rpcCall('exit-combined-before','getMultipleAccounts',[finalAddresses,{encoding:'base64',commitment:'confirmed'}]);
   await rpcCall('exit-combined-simulation','simulateTransaction',[Buffer.from(compiled.transaction.serialize()).toString('base64'),{encoding:'base64',sigVerify:false,replaceRecentBlockhash:true,commitment:'confirmed',accounts:{encoding:'base64',addresses:finalAddresses},innerInstructions:true}]);
 }
 await writeFile(new URL('exit-received-tokens.json',dir),JSON.stringify({received,withdrawSimulationSlot:simulation.result.context.slot,netRecovery:null,sent:false},null,2));
 }catch(e){attempts.push({name:'exit-probe',error:e.message});console.log('exit-probe',e.message);}
}
await writeFile(new URL((process.argv.includes('--prices')?'price':'exit')+'-attempts.json',dir),JSON.stringify({attempts,sent:false},null,2));

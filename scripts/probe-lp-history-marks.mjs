// Source-backed prior completed minute observations; never backfill current prices.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const dir=new URL('../specs/lp-decision/fixtures/closure/',import.meta.url),root=new URL('../specs/lp-decision/fixtures/',import.meta.url);
const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const tokens=[['a','SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb'],['b','Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8'],['ray','4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'],['sol','So11111111111111111111111111111111111111112']];
const signatures=JSON.parse(await readFile(new URL('rpc-position-signatures.json',root),'utf8')).result;
const days=new Map();for(const s of signatures){const day=new Date(s.blockTime*1000).toISOString().slice(0,10);days.set(day,Math.max(days.get(day)??0,s.blockTime));}
const refund=JSON.parse(await readFile(new URL((await readdir(dir)).find(name=>name.startsWith("related-tx-")),dir),"utf8")).result;
const refundDay=new Date(refund.blockTime*1000).toISOString().slice(0,10);if(!days.has(refundDay))days.set(refundDay,refund.blockTime);
let attempts=[];try{attempts=JSON.parse(await readFile(new URL('historical-mark-attempts.json',dir),'utf8')).attempts;}catch{}
for(const [label,mint] of tokens){
 const pools=JSON.parse(await readFile(new URL('historical-pools-'+label+'.json',dir),'utf8')).data;
 const pool=pools.find(p=>p.relationships.base_token.data.id==='solana_'+USDC||p.relationships.quote_token.data.id==='solana_'+USDC);
 if(!pool){console.log(label,'No direct USDC pool');continue;}
 const audit=JSON.parse(await readFile(new URL("public-position-flow-audit.json",root),"utf8"));
 const rewardDays=new Set(audit.rows.filter(r=>r.rewards.some(v=>v.amountAtomic!=="0")).map(r=>r.timestamp.slice(0,10)));
 for(const [day,time] of days){
  if(day===refundDay&&label!=="sol")continue;
  if(label==="ray"&&!rewardDays.has(day))continue;
  const path=new URL(`marks/${label}-${day}.json`,dir);
  try{const old=JSON.parse(await readFile(path,'utf8'));if(old.data?.attributes?.ohlcv_list?.length)continue;}catch{}
  await new Promise(resolve=>setTimeout(resolve,12500));
  const token=pool.relationships.base_token.data.id==='solana_'+mint?'base':'quote';
  const url=`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool.attributes.address}/ohlcv/minute?aggregate=1&limit=1000&before_timestamp=${time+60}&currency=token&token=${token}`;
  const observedAt=new Date().toISOString();
  try{const response=await fetch(url,{signal:AbortSignal.timeout(12000)});const data=await response.json(),raw=JSON.stringify(data,null,2);await writeFile(path,raw);attempts.push({label,mint,day,poolId:pool.attributes.address,denominator:USDC,url,observedAt,httpStatus:response.status,sha256:createHash('sha256').update(raw).digest('hex'),rows:data.data?.attributes?.ohlcv_list?.length??0});console.log(label,day,response.status,data.data?.attributes?.ohlcv_list?.length??0);await writeFile(new URL('historical-mark-attempts.json',dir),JSON.stringify({attempts,synthetic:false},null,2));if(response.status===429){console.log('Rate limit: stopped; rerun to resume without replacing successful observations.');process.exit(0);}}
  catch(e){attempts.push({label,day,url,observedAt,error:e.message});await writeFile(new URL('historical-mark-attempts.json',dir),JSON.stringify({attempts,synthetic:false},null,2));console.log(label,day,e.message);process.exit(0);}
 }
}

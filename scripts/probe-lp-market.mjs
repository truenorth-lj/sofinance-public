// Task-scoped public GETs only; no keys, wallet discovery or transaction building.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const dir=new URL("../specs/lp-decision/fixtures/",import.meta.url);
const selected=JSON.parse(await readFile(new URL("selected-public-position.json",dir),"utf8"));
const performance=JSON.parse(await readFile(new URL("position-performance-public.json",dir),"utf8"));
const attempts=[];
const requests=[
 ["gecko-historical-usd",`https://api.geckoterminal.com/api/v2/networks/solana/pools/${selected.poolId}/ohlcv/day?aggregate=1&limit=100&currency=usd&token=base`],
 ["jupiter-pair-current-price",`https://api.jup.ag/price/v3?ids=${performance.mintA},${performance.mintB}`],
 ...["A","B"].map((side)=>[`jupiter-exit-principal-${side.toLowerCase()}`,`https://api.jup.ag/swap/v1/quote?inputMint=${performance[`mint${side}`]}&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=${performance.metrics.liquidityAmountsRaw[side.toLowerCase()]}&slippageBps=50`])
];
for(const [name,url] of requests){
 const observedAt=new Date().toISOString();
 try{const response=await fetch(url,{signal:AbortSignal.timeout(12000)});const raw=await response.text();let body;try{body=JSON.parse(raw);}catch{body={text:raw.slice(0,2000)}}const serialized=JSON.stringify(body,null,2);await writeFile(new URL(`${name}.json`,dir),serialized);attempts.push({name,url,observedAt,httpStatus:response.status,sha256:createHash("sha256").update(serialized).digest("hex"),basis:name.startsWith("jupiter-exit")?"principal only from prior timestamped position snapshot; not full withdrawal/fee/reward/net quote":"market observation, not event-time valuation",bodyStatus:body.error??body.errorMessage??null});console.log(name,response.status);}
 catch(e){attempts.push({name,url,observedAt,error:e.message});console.log(name,e.message);}
}
await writeFile(new URL("market-attempts.json",dir),JSON.stringify({attempts,executable:false},null,2));

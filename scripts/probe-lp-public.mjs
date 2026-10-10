// Public, task-scoped pool evidence only. Never loads .env or queries wallet discovery.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
// Values verified against installed SDK common/programId.ts and clmm/layout.ts.
const CLMM_PROGRAM_ID = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const POSITION_SPAN = 281;
function base58(bytes) { const alphabet="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; let n=BigInt(`0x${bytes.toString("hex")}`), out=""; while(n>0n){out=alphabet[Number(n%58n)]+out;n/=58n;} for(const byte of bytes){if(byte!==0)break;out="1"+out;} return out; }
const poolId = "DUzBLHZ5RZdftPuWVijsvjupndogRM1adGJpsR7YTJro";
const rpc = "https://api.mainnet-beta.solana.com";
const dir = new URL("../specs/lp-decision/fixtures/", import.meta.url);
const resume = process.argv.includes("--resume");
const attempts = resume ? JSON.parse(await readFile(new URL("attempts.json",dir),"utf8")).attempts : [];
async function probe(name,url,body) {
  const startedAt = new Date().toISOString();
  try {
    const r = await fetch(url,{method:body?"POST":"GET",headers:{"Content-Type":"application/json"},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(12000)});
    const text = await r.text(); let data; try {data=JSON.parse(text);}catch{data={text:text.slice(0,1000)}}
    const raw=JSON.stringify(data,null,2); await writeFile(new URL(`${name}-${createHash("sha256").update(raw).digest("hex").slice(0,12)}.json`,dir),raw); await writeFile(new URL(`${name}.json`,dir),raw);
    attempts.push({name,url,startedAt,status:r.status,sha256:createHash("sha256").update(raw).digest("hex"),error:data.error??null});
    console.log(name,r.status,data.error??(Array.isArray(data.result)?`rows ${data.result.length}`:"received")); return data;
  } catch(e){const error={name,url,startedAt,error:e.message};attempts.push(error);console.log(name,error.error);return null;}
}
if (!resume) await probe("raydium-pool",`https://api-v3.raydium.io/pools/info/ids?ids=${poolId}`);
if (!resume) await probe("rpc-pool",rpc,{jsonrpc:"2.0",id:1,method:"getAccountInfo",params:[poolId,{encoding:"base64",commitment:"confirmed"}]});
const positions=resume ? JSON.parse(await readFile(new URL("rpc-public-positions.json",dir),"utf8")) : await probe("rpc-public-positions",rpc,{jsonrpc:"2.0",id:2,method:"getProgramAccounts",params:[CLMM_PROGRAM_ID,{encoding:"base64",commitment:"confirmed",filters:[{dataSize:POSITION_SPAN},{memcmp:{offset:41,bytes:poolId}}]}]});
if(Array.isArray(positions?.result)&&positions.result[0]) {
  const account=positions.result[0]; const bytes=Buffer.from(account.account.data[0],"base64");
  const positionMint=base58(bytes.subarray(9,41)); await writeFile(new URL("selected-public-position.json",dir),JSON.stringify({poolId,positionAccount:account.pubkey,positionMint,selection:"first pool-filtered public result, no wallet discovery",fetchedAt:new Date().toISOString()},null,2));
  const signatures=resume ? JSON.parse(await readFile(new URL("rpc-position-signatures.json",dir),"utf8")) : await probe("rpc-position-signatures",rpc,{jsonrpc:"2.0",id:3,method:"getSignaturesForAddress",params:[account.pubkey,{limit:100,commitment:"confirmed"}]});
  for(const item of (signatures?.result??[]).slice(0,60)) {
    const name=`rpc-position-tx-${item.signature}`;
    if(resume){try { const cached=JSON.parse(await readFile(new URL(`${name}.json`,dir),"utf8"));if(cached.result)continue; }catch{ /* missing fixture */ }}
    await new Promise(resolve=>setTimeout(resolve,1300));
    const value=await probe(name,rpc,{jsonrpc:"2.0",id:4,method:"getTransaction",params:[item.signature,{encoding:"jsonParsed",commitment:"confirmed",maxSupportedTransactionVersion:0}]});
    if(value?.error?.code===429) {console.log("Rate limit: stopping rather than issuing more transaction calls; --resume later.");break;}
  }
}
if (!resume) await probe("jupiter-current-price",`https://api.jup.ag/price/v3?ids=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`);
if (!resume) await probe("gecko-historical-bars",`https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolId}/ohlcv/day?aggregate=1&limit=30&currency=token`);
await writeFile(new URL("attempts.json",dir),JSON.stringify({poolId,rpc,attempts},null,2));

"use client";
import {useEffect,useRef,useState} from "react";
import Decimal from "decimal.js";
import {DecisionSession} from "@/lib/lp-decision-session";
import type {BoundedMetric} from "@/lib/lp-ledger-analysis";
type Analysis={historical:BoundedMetric;hodl:BoundedMetric;excess:BoundedMetric;knownSubtotal:{lower:string|null;upper:string|null;label:string};completeness:Record<string,string|boolean>;classification:{policy:string;unknowns:{reason:string}[];crossTransactionCandidates:unknown[]};pricePolicy:string;costs?:{id:string;totalLamports:string|null;lowerLamports:string|null;upperLamports:string|null;allocation:string}[];rentRefunds?:{signature:string;refundLamports:string|null}[]};
type Ledger={source:{kind:string;fresh:boolean;synthetic:boolean;asOf?:string};accounting?:Analysis;nextCursor:string|null;historyReachedEnd:boolean;verifiedTransactionCount:number;errors?:{detail:string}[];error?:string};
type Exit={status:string;error?:string;reason?:string;recoveryUSDCAtomic?:string;recoverySOLLamports?:string;networkAndPriorityLamports?:string|null;observedAt?:string;localExpiresAt?:string;remainingTokenDeltas?:string[];bytes?:number;executable?:boolean;sent?:boolean};
const number=(v:string)=>new Decimal(v).toFixed(4);
export function LpPositionEvidence({positionId}:{positionId:string}){
 const [ledger,setLedger]=useState<Ledger|null>(null),[exit,setExit]=useState<Exit|null>(null),[busy,setBusy]=useState<"ledger"|"exit"|null>(null),[error,setError]=useState<string|null>(null),[now,setNow]=useState(()=>Date.now());
 const session=useRef(new DecisionSession()),resume=useRef<string|null>(null);
 const cancel=()=>{session.current.cancel();setBusy(null);setLedger(null);setExit(null);setError(null);resume.current=null;};
 useEffect(()=>{const value=session.current;return()=>value.cancel();},[positionId]);
 useEffect(()=>{if(!exit?.localExpiresAt&&!ledger?.source.asOf)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[exit?.localExpiresAt,ledger?.source.asOf]);
 async function run(kind:"ledger"|"exit"){
  const job=session.current.begin();if(!job)return;setBusy(kind);setError(null);if(kind==="exit")setExit(null);
  try{let before:string|null=kind==="ledger"?resume.current:null;const cursors=new Set<string>();
   for(let page=0;page<(kind==="ledger"?30:1);page++){
    const url=kind==="exit"?`/api/lp-decision/exit-preview?positionId=${encodeURIComponent(positionId)}&convertRent=0`:`/api/lp-decision/ledger?positionId=${encodeURIComponent(positionId)}&source=live&analyze=1${before?`&before=${encodeURIComponent(before)}`:""}`;
    const response=await fetch(url,{signal:job.signal});const body=await response.json();if(!job.current())return;
    if(!response.ok)throw new Error(body.error??"公開來源暫不可用");
    if(kind==="exit"){if(body.sent!==false||body.executable!==false)throw new Error("唯讀退出契約不符");if(body.status==="verified-preview"&&(!/^\d+$/.test(body.recoveryUSDCAtomic??"")||! /^-?\d+$/.test(body.recoverySOLLamports??"")||!Number.isFinite(Date.parse(body.localExpiresAt??""))))throw new Error("退出數量／有效時間缺失");setExit(body);setNow(Date.now());break;}
    if(body.source?.kind!=="live"||body.source?.synthetic!==false||body.source?.fresh!==true)throw new Error("正式台帳拒絕 demo／重播來源");
    const data=body as Ledger;setLedger(data);setNow(Date.now());resume.current=data.nextCursor;if(data.errors?.length){setError(data.errors.map(e=>e.detail).join("；"));break;}if(data.historyReachedEnd||!data.nextCursor)break;
    if(cursors.has(data.nextCursor))throw new Error("來源未前進，保留已讀部分並停止");cursors.add(data.nextCursor);before=data.nextCursor;
   }
  }catch(e){if(job.current())setError(e instanceof Error?e.message:"來源讀取失敗");}
  finally{if(job.current())setBusy(null);job.finish();}
 }
 const expired=!!exit?.localExpiresAt&&now>=Date.parse(exit.localExpiresAt);
 const bounded=(label:string,m:BoundedMetric)=><div className="my-3"><p>{label}：{m.lower===null&&m.upper===null?"完整值 unavailable":`${m.lower===null?"下界未知":number(m.lower)} ～ ${m.upper===null?"上界未知":number(m.upper)} USDC`}</p><p className="text-xs">{m.status} · {m.missing.length} 項缺口；是來源參考估值範圍，不是機率／信賴區間。</p></div>;
 return <div aria-label="持倉台帳與退出預覽" className="mt-4 rounded-2xl border border-sky-900 p-4">
  <p className="font-semibold">持倉實際資料與退出預覽</p><p className="mt-2 text-xs">另行讀取當前公開帳戶，重播檔不作正式數值。僅唯讀模擬，不簽名或送出。</p>
  <div className="my-3 flex flex-wrap gap-3"><button disabled={!!busy} onClick={()=>void run("ledger")} className="rounded-xl bg-neutral-800 px-4 py-2 disabled:opacity-40">{busy==="ledger"?"台帳讀取中…":"讀取實際台帳與歷史／HODL"}</button><button disabled={!!busy} onClick={()=>void run("exit")} className="rounded-xl bg-sky-900 px-4 py-2 disabled:opacity-40">{busy==="exit"?"退出模擬中…":"預覽退出：USDC＋SOL"}</button><button onClick={cancel} className="text-neutral-400">取消資料讀取</button></div>
  {error&&<p role="alert" className="text-amber-200">{error}</p>}
  {ledger&&<div><p className="text-xs">估值截點 {ledger.source.asOf??"未知"} · {ledger.source.asOf&&now-Date.parse(ledger.source.asOf)>60000?"當前部位估值已超過 60 秒，請刷新；歷史原始交易仍保留":"本次公開資料快照"}</p><p>已核對 {ledger.verifiedTransactionCount} 筆 · 歷史 {ledger.historyReachedEnd?"讀至起點":"仍有未讀窗口"}</p>{ledger.accounting&&<>
   <p className="text-xs">部位對帳 {String(ledger.accounting.completeness.positionAccounting)} · 全錢包 {String(ledger.accounting.completeness.walletAccounting)}（不阻擋部位指標）</p>
   {bounded("歷史絕對淨損益",ledger.accounting.historical)}{bounded("同邊界資金流 HODL",ledger.accounting.hodl)}{bounded("相對 HODL 超額損益",ledger.accounting.excess)}
   <p>{ledger.accounting.knownSubtotal.lower!==null&&ledger.accounting.knownSubtotal.upper!==null?`已核對且有價格的部分合計 ${number(ledger.accounting.knownSubtotal.lower)} ～ ${number(ledger.accounting.knownSubtotal.upper)} USDC；不是完整淨收益。`:"尚無可計價的已核對項目；不以零替代缺資料。"}</p>
   <details><summary>共同成本與可退租金</summary>{ledger.accounting.costs?.map(c=><p key={c.id} className="break-all text-xs">{c.id} · 全交易實付 {c.totalLamports??"未知"} lamports · 部位分攤範圍 [{c.lowerLamports??"未知"}, {c.upperLamports??"未知"}]；{c.allocation}。共同成本區間不是鏈上精確單 LP 成本。</p>)}{ledger.accounting.rentRefunds?.map(r=><p key={r.signature} className="text-xs">NFT 租金退款 {r.refundLamports??"未核對"} lamports；是資產回收，不再計收入。</p>)}</details>
   <details><summary>歸屬與估值政策</summary><p className="break-all text-xs">{ledger.accounting.classification.policy}</p><p className="text-xs">{ledger.accounting.pricePolicy}</p><p>跨交易待核實複投候選 {ledger.accounting.classification.crossTransactionCandidates.length} 筆；其他歸屬未知 {ledger.accounting.classification.unknowns.length} 筆。</p>{ledger.accounting.historical.missing.map((m,i)=><p key={i} className="break-all text-xs">{m}</p>)}</details>
  </>}</div>}
  {exit&&<div aria-label="分資產退出結果"><p className="font-semibold">{expired?"退出預覽已過期，請重新讀取":exit.status==="verified-preview"?"USDC＋SOL 分資產退出模擬已核對":"退出資料不足／部分"}</p>
   {exit.recoveryUSDCAtomic&&exit.recoverySOLLamports&&<><p>{exit.status==="verified-preview"?"模擬回收":"部分模擬餘額變化（仍有未回收資產）"} {new Decimal(exit.recoveryUSDCAtomic).div(1e6).toFixed(6)} USDC ＋ {new Decimal(exit.recoverySOLLamports).div(1e9).toFixed(9)} SOL</p><p>network＋priority {exit.networkAndPriorityLamports??"未知"} lamports，已反映於 SOL 淨變化，不再扣一次；換幣費用／價格影響已反映於模擬 USDC 實收。</p></>}
   <p className="text-xs">取得 {exit.observedAt??"未知"} · 有效至 {exit.localExpiresAt??"未知"}（本地保守刷新期限） · {exit.bytes??"未知"} bytes</p><p>SOL 保留價格曝險；這是分資產回收，不是全 USDC 現金。唯讀模擬不可簽送。</p>{(exit.error||exit.reason)&&<p>{exit.error||exit.reason}</p>}
  </div>}
 </div>;
}

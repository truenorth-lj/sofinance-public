"use client";
import "@/lib/engine-host";
import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { useWalletConnection } from "./wallet-connection";
import { NATIVE_SOL_MINT } from "@sofinance/engine/ids";
import { formatAmount } from "@sofinance/engine/amount";
import { notifyPositionHistoryChange } from "@/lib/position-history-refresh";
import type { WithdrawPrepared, WithdrawSummary, WithdrawRequest } from "@sofinance/engine/withdraw/types";

const REQUEST_TIMEOUT_MS=45_000;
type Checkpoint = { prepared: WithdrawPrepared; signature: string; request: WithdrawRequest; confirmHighImpact: boolean; root?: {prepared:WithdrawPrepared;signature:string} };
async function post<T>(path: string, body: unknown): Promise<T> {
 let response:Response;
 try{response=await fetch(`/api/${path}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),cache:"no-store",signal:AbortSignal.timeout(REQUEST_TIMEOUT_MS)});}
 catch(caught){throw new Error(caught instanceof DOMException && caught.name==="TimeoutError"?"The server took too long to respond. Check your connection and try again.":"Network error. Check your connection and try again.");}
 const value=await response.json().catch(()=>({error:`Server error (${response.status}). Try again in a moment.`}));
 if(!response.ok)throw new Error(value.error || "Unable to complete withdrawal");
 return value as T;
}
export function WithdrawPanel({wallet,positionMint,mintA,mintB,label,onClose,onBusyChange,onConfirmed}:{wallet:string;positionMint:string;mintA:string;mintB:string;label:(mint:string)=>string;onClose:()=>void;onBusyChange:(busy:boolean)=>void;onConfirmed:()=>void}) {
 const connection=useWalletConnection();
 const [percent,setPercent]=useState(100),[target,setTarget]=useState(""),[receive,setReceive]=useState("usdc");
 const [preview,setPreview]=useState<WithdrawSummary|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(""),[progress,setProgress]=useState("");
 const [confirmation,setConfirmation]=useState(false),[previewing,setPreviewing]=useState(false);
 const key=`sofinance:withdraw:${wallet}:${positionMint}`;
 const [checkpoint,setCheckpoint]=useState<Checkpoint|null>(()=>{
  if(typeof window==="undefined")return null;
  try {return JSON.parse(localStorage.getItem(key) || "null") as Checkpoint|null;}catch{return null;}
 });
 const confirmationRef=useRef<HTMLDialogElement>(null);
 useEffect(()=>{
  const dialog=confirmationRef.current;
  if(confirmation && dialog && !dialog.open)dialog.showModal();
  if(!confirmation && dialog?.open)dialog.close();
 },[confirmation]);
 const locked=useRef(false);
 useEffect(()=>{onBusyChange(busy || !!checkpoint);return()=>onBusyChange(false);},[busy,checkpoint,onBusyChange]);
 const request:WithdrawRequest={wallet,positionMint,...(target?{targetUSDC:Number(target)}:{percent}),receive:receive==="usdc"?"usdc":receive==="original"?"original":"token",...(receive!=="usdc" && receive!=="original"?{outputMint:receive}:{})};
 function invalidate(){setPreview(null);setError("");setConfirmation(false);}
 const targetInvalid=target!=="" && !(Number.isFinite(Number(target)) && Number(target)>0);
 async function showPreview(){
  if(locked.current)return;
  if(targetInvalid){setError("Enter a USDC amount above 0, or clear it to use the slider.");return;}
  locked.current=true;setBusy(true);setPreviewing(true);setError("");setProgress("Calculating preview…");
  try{const result=await post<WithdrawSummary>("withdraw-quote",request);setPreview(result);setPercent(result.percentBps/100);setProgress("Review the preview, then tap Withdraw.");}
  catch(caught){setProgress("");setError(caught instanceof Error?caught.message:"Preview failed");}
  finally{setBusy(false);setPreviewing(false);locked.current=false;}
 }
 function save(value:Checkpoint|null){if(value)localStorage.setItem(key,JSON.stringify(value));else localStorage.removeItem(key);setCheckpoint(value);}
 async function waitFor(saved:Checkpoint){
  for(let i=0;i<60;i++){
   const result=await post<{status:string}>("withdraw-status",{signature:saved.signature,prepared:saved.prepared});
   if(result.status==="success"){
    notifyPositionHistoryChange(saved.prepared.summary.positionMint,saved.prepared.summary.stage==="swap"?undefined:saved.signature);
    return;
   }
   if(result.status==="failed" || result.status==="expired")save(saved.root?{...saved,prepared:saved.root.prepared,signature:saved.root.signature,root:undefined}:null);
   if(result.status!=="pending")throw new Error(`Transaction status: ${result.status}. Review it before starting another withdrawal.`);
   setProgress("Waiting for transaction to finalize…");await new Promise(resolve=>setTimeout(resolve,2000));
  }
  throw new Error("Confirmation is taking longer. Resume to check the same transaction.");
 }
 async function signAndSend(prepared:WithdrawPrepared,confirmed:boolean,originalRequest:WithdrawRequest,root?:Checkpoint["root"]){
  if(connection.address!==wallet)throw new Error("Connect the wallet that owns this position");
  if(Date.now()>=prepared.summary.expiresAt)throw new Error("Preview expired. Prepare again.");
  setProgress(prepared.summary.stage==="swap"?"Step 2 of 2: approve conversion in your wallet":"Approve withdrawal in your wallet");
  const unsigned=VersionedTransaction.deserialize(Uint8Array.from(atob(prepared.unsignedTransaction),c=>c.charCodeAt(0)));
  const message=unsigned.message.serialize().slice();
  const signed=await connection.signTransaction(unsigned);
  if(signed.message.serialize().length!==message.length || signed.message.serialize().some((b,i)=>b!==message[i]))throw new Error("Wallet modified transaction");
  const saved:Checkpoint={prepared,signature:bs58.encode(signed.signatures[0]!),request:originalRequest,confirmHighImpact:confirmed,root};
  // Persist before broadcasting: an interrupted HTTP request can still land.
  save(saved);setProgress("Submitting withdrawal…");
  await post("withdraw-broadcast",{wallet,summary:prepared.summary,permit:prepared.permit,confirmHighImpact:confirmed,signedTransaction:btoa(String.fromCharCode(...signed.serialize()))});
  return saved;
 }
 async function run(confirmed=false){
  if(locked.current)return;locked.current=true;setBusy(true);setError("");setConfirmation(false);
  try{
   let saved=checkpoint;
   if(!saved){const prepared=await post<WithdrawPrepared>("withdraw-prepare",{...request,confirmHighImpact:confirmed});saved=await signAndSend(prepared,confirmed,request);}
   await waitFor(saved);
   if(saved.prepared.summary.stage==="withdraw"){
    setProgress("Step 1 of 2 complete. Preparing conversion…");
    const nextRequest={...saved.request,stage:"swap",previous:saved.prepared,tx1Signature:saved.signature,confirmHighImpact:confirmed || saved.confirmHighImpact};
    const nextPreview=await post<WithdrawSummary>("withdraw-quote",nextRequest);
    setPreview(nextPreview);
    if(nextPreview.requiresSecondConfirmation && !nextRequest.confirmHighImpact){setConfirmation(true);setProgress("Confirm the conversion price impact to continue");return;}
    const prepared=await post<WithdrawPrepared>("withdraw-prepare",nextRequest);
    saved=await signAndSend(prepared,confirmed || saved.confirmHighImpact,saved.request,{prepared:saved.prepared,signature:saved.signature});
    await waitFor(saved);
   }
   save(null);setProgress("Withdrawal complete");setPreview(null);onConfirmed();
  }catch(caught){setProgress("");setError(caught instanceof Error?caught.message:"Withdrawal failed");}
  finally{setBusy(false);locked.current=false;}
 }
 const disabled=busy || !!checkpoint;
 return <section aria-label="Withdraw from position" className="mt-4 rounded-3xl border border-white/20 bg-char p-5 text-cream">
  <div className="flex justify-between"><h2>Withdraw from position</h2><button disabled={busy || !!checkpoint} onClick={onClose}>Close</button></div>
  <label className="mt-4 block">Withdraw {percent}%<input type="range" min="1" max="100" step="1" value={percent} disabled={disabled} onChange={e=>{setPercent(Number(e.target.value));setTarget("");invalidate();}} className="block w-full" /></label>
  <label className="mt-3 block">Target USDC estimate<input aria-label="Target USDC estimate" type="number" min="0" value={target} disabled={disabled} onChange={e=>{setTarget(e.target.value);invalidate();}} className="ml-3 rounded bg-canvas p-2" /></label>
  <label className="mt-3 block">Receive<select value={receive} disabled={disabled} onChange={e=>{setReceive(e.target.value);invalidate();}} className="ml-3 rounded bg-canvas p-2">
   <option value="usdc">USDC</option><option value={NATIVE_SOL_MINT}>SOL</option>
   {[...new Set([mintA,mintB])].filter(m=>m!==NATIVE_SOL_MINT).map(m=><option key={m} value={m}>{label(m)}</option>)}
   <option value="original">Original tokens</option>
  </select></label>
  <p className="mt-3 text-sm">Withdrawing 100% closes your position and returns its account deposit in SOL.</p>
  {preview && <div className="mt-4 text-sm">
   {preview.outputs.map(o=><p key={o.mint}>Minimum received: {formatAmount(o.minimum,o.decimals)} {o.mint===NATIVE_SOL_MINT && preview.receive==="token"?"SOL":label(o.mint)}</p>)}
   <p>Price impact: {(preview.priceImpactBps/100).toFixed(2)}% · Slippage: {(preview.slippageBps/100).toFixed(2)}%</p>
   <p>Conversion fee: {(preview.protocolFee.bps/100).toFixed(2)}% on converted tokens only</p>
   {preview.protocolFee.legs.map((fee,i)=>{
    const mint=fee.collectedMint??fee.mint;
    const decimals=preview.assets.find(a=>a.mint===mint)?.decimals??6;
    return <p key={i}>Fee estimate: {formatAmount(fee.collectedAmount??fee.amount,decimals)} {label(mint)}</p>;
   })}
   <p>Account deposit returned: {formatAmount(preview.rentRefundLamports,9)} SOL</p>
   <p>{preview.transactions===2?"Two steps: withdraw tokens, then convert after confirmation.":"One transaction"}</p>
   {preview.warning && <p role="alert" className="mt-2 text-lemon">This conversion may reduce what you receive by more than 2%.</p>}
  </div>}
  {error && <p role="alert" className="mt-3 rounded-2xl border border-lemon/60 bg-lemon/10 p-3 text-sm text-lemon">{error}</p>}
  <p role="status" aria-live="polite" className="mt-3 text-sm text-smoke">{busy && <LoaderCircle aria-hidden className="mr-2 inline h-4 w-4 animate-spin" />}{progress}</p>
  {checkpoint ? <button disabled={busy} onClick={()=>{if(checkpoint.prepared.summary.requiresSecondConfirmation)setConfirmation(true);else void run();}} className="mt-3 rounded-full bg-lemon px-5 py-3 text-ink">Resume withdrawal</button> : <>
   <button type="button" disabled={busy} aria-busy={previewing} onClick={()=>void showPreview()} className="mt-3 rounded-full border px-5 py-3 disabled:opacity-50">{previewing?"Calculating…":"Preview"}</button>
   {/* Without a preview, Withdraw fetches one first so the tap is never silent; a second tap confirms. */}
   <button type="button" disabled={busy} aria-busy={busy && !previewing} onClick={()=>{if(!preview)void showPreview();else if(preview.requiresSecondConfirmation)setConfirmation(true);else void run();}} className="ml-3 rounded-full bg-lemon px-5 py-3 text-ink disabled:opacity-50">{busy && !previewing?"Withdrawing…":"Withdraw"}</button>
  </>}
  <dialog ref={confirmationRef} role="alertdialog" aria-label="Confirm high price impact" onCancel={event=>{event.preventDefault();setConfirmation(false);}} onClose={()=>setConfirmation(false)} className="fixed left-1/2 top-1/2 m-0 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-lemon bg-char p-5 text-cream backdrop:bg-black/70"><p>Price impact exceeds 5%. You may receive substantially less. Continue with this conversion?</p><button onClick={()=>void run(true)} className="mt-3 rounded bg-lemon p-2 text-ink">Confirm high price impact</button><button onClick={()=>setConfirmation(false)} className="ml-3">Cancel</button></dialog>
 </section>;
}

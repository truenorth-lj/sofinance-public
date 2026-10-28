"use client";
import "@/lib/engine-host";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { useWalletConnection } from "./wallet-connection";
import { NATIVE_SOL_MINT } from "@sofinance/engine/ids";
import { formatAmount } from "@sofinance/engine/amount";
import { notifyPositionHistoryChange } from "@/lib/position-history-refresh";
import { createJupiterRelayStore, postWithJupiterRelay } from "@/lib/jupiter/browser-relay";
import type { WithdrawPrepared, WithdrawSummary, WithdrawRequest } from "@sofinance/engine/withdraw/types";
import { assertWithdrawHistory, readWithdrawHistory, writeWithdrawHistory, withdrawCheckpointKey, WithdrawHistoryError, WITHDRAW_HISTORY_ERROR, type WithdrawHistory, type WithdrawCheckpoint as Checkpoint } from "@/lib/withdraw-checkpoint";
import { prepareIsStale } from "@sofinance/engine/fresh-blockhash";
import { assertWalletReturnedTransaction } from "@/lib/wallet-returned-guard";

export const WITHDRAW_EXPIRED_MESSAGE = "Transaction expired before it landed. Retry to prepare a fresh transaction — no funds moved.";

const REQUEST_TIMEOUT_MS=45_000;
const RELAYED_PATHS=new Set(["withdraw-quote","withdraw-prepare"]);
const withdrawJupiterStore=createJupiterRelayStore();
type WithdrawRun = { lifetime: object; controller: AbortController };
class WithdrawCancelled extends Error {}

// The run owns both the fetch deadline and cancellation listener through body parsing.
async function post<T>(run: WithdrawRun, path: string, body: unknown): Promise<T> {
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(new DOMException("Request timed out","TimeoutError")),REQUEST_TIMEOUT_MS);
 const cancel=()=>{clearTimeout(timer);controller.abort(run.controller.signal.reason);};
 run.controller.signal.addEventListener("abort",cancel,{once:true});
 try{
  if(run.controller.signal.aborted)cancel();
  const signal=controller.signal;
  let response:Response;
  try{
   signal.throwIfAborted();
   // Withdraw preview/prepare may swap via Jupiter: those quotes come from this browser.
   response=RELAYED_PATHS.has(path)&&body&&typeof body==="object"
    ?await postWithJupiterRelay(`/api/${path}`,body as Record<string,unknown>,{store:withdrawJupiterStore,signal})
    :await fetch(`/api/${path}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),cache:"no-store",signal});
  }catch{
   if(run.controller.signal.aborted)throw new WithdrawCancelled();
   throw new Error(signal.reason instanceof DOMException && signal.reason.name==="TimeoutError"?"The server took too long to respond. Check your connection and try again.":"Network error. Check your connection and try again.");
  }
  signal.throwIfAborted();
  const value=await response.json().catch(()=>({error:`Server error (${response.status}). Try again in a moment.`}));
  signal.throwIfAborted();
  if(!response.ok)throw new Error(value.error || "Unable to complete withdrawal");
  return value as T;
 }finally{clearTimeout(timer);run.controller.signal.removeEventListener("abort",cancel);}
}
function waitForNextStatus(run:WithdrawRun){
 return new Promise<void>((resolve,reject)=>{
  const signal=run.controller.signal;
  if(signal.aborted){reject(new WithdrawCancelled());return;}
  const cancel=()=>{clearTimeout(timer);reject(new WithdrawCancelled());};
  const timer=setTimeout(()=>{signal.removeEventListener("abort",cancel);resolve();},2000);
  signal.addEventListener("abort",cancel,{once:true});
 });
}
export function WithdrawPanel({wallet,positionMint,mintA,mintB,label,onClose,onBusyChange,onConfirmed}:{wallet:string;positionMint:string;mintA:string;mintB:string;label:(mint:string)=>string;onClose:()=>void;onBusyChange:(busy:boolean)=>void;onConfirmed:()=>void}) {
 const connection=useWalletConnection();
 const [percent,setPercent]=useState(100),[target,setTarget]=useState(""),[receive,setReceive]=useState("usdc");
 const [preview,setPreview]=useState<WithdrawSummary|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(""),[progress,setProgress]=useState("");
 const [confirmation,setConfirmation]=useState(false),[previewing,setPreviewing]=useState(false);
 const [initialHistory]=useState(()=>readWithdrawHistory(wallet,positionMint));
 const historyRef=useRef(initialHistory);
 const blockedHistories=useRef(new Map<string,{history:WithdrawHistory;error:string}>(
  initialHistory.kind==="invalid" || initialHistory.kind==="unavailable"
   ?[[withdrawCheckpointKey(wallet,positionMint),{history:initialHistory,error:WITHDRAW_HISTORY_ERROR}]]:[]));
 const [checkpoint,setCheckpoint]=useState<Checkpoint|null>(initialHistory.kind==="valid"?initialHistory.checkpoint:null);
 const [historyError,setHistoryError]=useState(initialHistory.kind==="invalid" || initialHistory.kind==="unavailable"?WITHDRAW_HISTORY_ERROR:"");
 // Latch uncertain storage mutations until reload; keep the last verified in-memory checkpoint.
 function guardHistory(){
  if(historyError || blockedHistories.current.has(withdrawCheckpointKey(wallet,positionMint)))throw new WithdrawHistoryError();
  assertWithdrawHistory(wallet,positionMint,historyRef.current);
 }
 function showError(caught:unknown,fallback:string){
  if(caught instanceof WithdrawHistoryError){
   blockedHistories.current.set(withdrawCheckpointKey(wallet,positionMint),{history:historyRef.current,error:caught.message});
   setHistoryError(caught.message);
  }
  setError(caught instanceof Error?caught.message:fallback);
 }
 const confirmationRef=useRef<HTMLDialogElement>(null);
 useEffect(()=>{
  const dialog=confirmationRef.current;
  if(confirmation && dialog && !dialog.open)dialog.showModal();
  if(!confirmation && dialog?.open)dialog.close();
 },[confirmation]);
 const lifetimeRef=useRef<object|null>(null);
 const runningRef=useRef<WithdrawRun|null>(null);
 const currentConnection=useRef(connection);
 const currentOnConfirmed=useRef(onConfirmed);
 const historyIdentity=useRef({wallet,positionMint});
 // Only committed identity changes invalidate a run. Callback/object churn does not.
 useLayoutEffect(()=>{currentConnection.current=connection;currentOnConfirmed.current=onConfirmed;});
 useLayoutEffect(()=>{
  lifetimeRef.current={};
  // Effects may reconnect with retained state (including layout-only Suspense).
  // Reset ephemeral approval/preview, never the durable checkpoint or pending lock.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- Reconcile retained UI before it becomes actionable again.
  setPreview(null);setConfirmation(false);setProgress("");
  if(historyIdentity.current.wallet!==wallet || historyIdentity.current.positionMint!==positionMint){
   // A different identity may proceed, but returning to this one is not a reload.
   const key=withdrawCheckpointKey(wallet,positionMint),blocked=blockedHistories.current.get(key);
   const history=blocked?.history ?? readWithdrawHistory(wallet,positionMint);
   if(history.kind==="invalid" || history.kind==="unavailable")blockedHistories.current.set(key,{history,error:WITHDRAW_HISTORY_ERROR});
   historyIdentity.current={wallet,positionMint};historyRef.current=history;
   setCheckpoint(history.kind==="valid"?history.checkpoint:null);
   setHistoryError(blocked?.error ?? (history.kind==="invalid" || history.kind==="unavailable"?WITHDRAW_HISTORY_ERROR:""));
   setError("");
  }
  return()=>{
   lifetimeRef.current=null;
   // Abort never means unsent: preserve any checkpoint written before broadcast.
   runningRef.current?.controller.abort();
  };
 },[wallet,positionMint,connection.address,connection.connected]);
 function begin():WithdrawRun|null{
  if(runningRef.current || !lifetimeRef.current)return null;
  const run={lifetime:lifetimeRef.current,controller:new AbortController()};
  runningRef.current=run;return run;
 }
 function owns(run:WithdrawRun){return runningRef.current===run && lifetimeRef.current===run.lifetime && !run.controller.signal.aborted;}
 function guardRun(run:WithdrawRun){
  if(!owns(run))throw new WithdrawCancelled();
  guardHistory();
  if(!currentConnection.current.connected || currentConnection.current.address!==wallet)throw new Error("Connect the wallet that owns this position");
 }
 function finish(run:WithdrawRun){
  if(runningRef.current!==run)return;
  runningRef.current=null;
  // Keep the synchronous lock until the real wallet promise settles. Clearing this
  // run's UI even while hidden avoids a permanently busy retained instance.
  setBusy(false);setPreviewing(false);
 }
 useEffect(()=>{onBusyChange(busy || !!checkpoint || !!historyError);return()=>onBusyChange(false);},[busy,checkpoint,historyError,onBusyChange]);
 const request:WithdrawRequest={wallet,positionMint,...(target?{targetUSDC:Number(target)}:{percent}),receive:receive==="usdc"?"usdc":receive==="original"?"original":"token",...(receive!=="usdc" && receive!=="original"?{outputMint:receive}:{})};
 function invalidate(){setPreview(null);setError("");setConfirmation(false);}
 const targetInvalid=target!=="" && !(Number.isFinite(Number(target)) && Number(target)>0);
 async function showPreview(){
  if(runningRef.current)return;
  if(targetInvalid){setError("Enter a USDC amount above 0, or clear it to use the slider.");return;}
  const run=begin();if(!run)return;setBusy(true);setPreviewing(true);setError("");setProgress("Calculating preview…");
  try{guardRun(run);const result=await post<WithdrawSummary>(run,"withdraw-quote",request);guardRun(run);setPreview(result);setPercent(result.percentBps/100);setProgress("Review the preview, then tap Withdraw.");}
  catch(caught){if(owns(run)){setProgress("");showError(caught,"Preview failed");}}
  finally{finish(run);}
 }
 function save(run:WithdrawRun,value:Checkpoint|null){
  guardRun(run);
  const verified=writeWithdrawHistory(wallet,positionMint,historyRef.current,value);
  historyRef.current=verified;setCheckpoint(value);
 }
 async function waitFor(run:WithdrawRun,saved:Checkpoint){
  for(let i=0;i<60;i++){
   guardRun(run);
   const result=await post<{status:string}>(run,"withdraw-status",{signature:saved.signature,prepared:saved.prepared});
   guardRun(run);
   if(result.status==="success"){
    notifyPositionHistoryChange(saved.prepared.summary.positionMint,saved.prepared.summary.stage==="swap"?undefined:saved.signature);
    return;
   }
   if(result.status==="failed" || result.status==="expired")save(run,saved.root?{...saved,prepared:saved.root.prepared,signature:saved.root.signature,root:undefined}:null);
   if(result.status==="expired")throw new Error(saved.root?"Conversion expired. Resume to verify the original withdrawal and retry conversion.":WITHDRAW_EXPIRED_MESSAGE);
   if(result.status!=="pending")throw new Error(`Transaction status: ${result.status}. Review it before starting another withdrawal.`);
   setProgress("Waiting for transaction to finalize…");await waitForNextStatus(run);
  }
  throw new Error("Confirmation is taking longer. Resume to check the same transaction.");
 }
 async function signAndSend(run:WithdrawRun,prepared:WithdrawPrepared,confirmed:boolean,originalRequest:WithdrawRequest,root?:Checkpoint["root"]){
  guardRun(run);
  if(Date.now()>=prepared.summary.expiresAt || prepareIsStale(prepared.summary)){
   setProgress("Refreshing transaction…");
   prepared=await post<WithdrawPrepared>(run,"withdraw-prepare",prepared.summary.stage==="swap"&&root
    ?{...originalRequest,confirmHighImpact:confirmed,stage:"swap",previous:root.prepared,tx1Signature:root.signature}
    :{...originalRequest,confirmHighImpact:confirmed});
  }
  guardRun(run);
  setProgress(prepared.summary.stage==="swap"?"Step 2 of 2: approve conversion in your wallet":"Approve withdrawal in your wallet");
  const unsigned=VersionedTransaction.deserialize(Uint8Array.from(atob(prepared.unsignedTransaction),c=>c.charCodeAt(0)));
  const preparedSnapshot=VersionedTransaction.deserialize(unsigned.serialize());
  const signed=await currentConnection.current.signTransaction(unsigned);
  guardRun(run);
  if(Date.now()>=prepared.summary.expiresAt)throw new Error("Prepared transaction expired while awaiting wallet approval. Review and retry; no new transaction was submitted.");
  assertWalletReturnedTransaction(preparedSnapshot,signed,wallet);
  const saved:Checkpoint={prepared,signature:bs58.encode(signed.signatures[0]!),request:originalRequest,confirmHighImpact:confirmed,root};
  // Persist before broadcasting: an interrupted HTTP request can still land.
  save(run,saved);setProgress("Submitting withdrawal…");
  try{
   await post(run,"withdraw-broadcast",{wallet,summary:prepared.summary,permit:prepared.permit,confirmHighImpact:confirmed,unsignedTransaction:prepared.unsignedTransaction,signedTransaction:btoa(String.fromCharCode(...signed.serialize()))});
  }catch(error){
   // Pre-send 4xx (budget, simulation) never reached the RPC. Restore the first-stage
   // checkpoint so Resume re-prepares conversion instead of waiting on a never-sent sig.
   if(root && /exceeds SOL cost budget|priority fee exceeds|simulation failed|authorization|Invalid or expired|Invalid wallet signature|blockhash expired|required instruction|Wallet (?:changed|dropped|removed)|Confirm|balance changed|below simulated|existing wallet inventory|output below/i.test(error instanceof Error?error.message:"")){
    save(run,{prepared:root.prepared,signature:root.signature,request:originalRequest,confirmHighImpact:confirmed});
   }
   throw error;
  }
  return saved;
 }
 async function run(confirmed=false){
  const run=begin();if(!run)return;setBusy(true);setError("");setConfirmation(false);
  try{
   guardRun(run);
   const resuming=!!checkpoint;
   let saved=checkpoint;
   if(!saved){const prepared=await post<WithdrawPrepared>(run,"withdraw-prepare",{...request,confirmHighImpact:confirmed});saved=await signAndSend(run,prepared,confirmed,request);}
   if(resuming && saved.prepared.summary.stage==="swap" && saved.root){
    const result=await post<{status:string}>(run,"withdraw-status",{signature:saved.signature,prepared:saved.prepared});
    guardRun(run);
    if(result.status==="success"){
     notifyPositionHistoryChange(saved.prepared.summary.positionMint,undefined);
     save(run,null);setProgress("Withdrawal complete");setPreview(null);currentOnConfirmed.current();return;
    }
    if(result.status==="failed" || result.status==="expired"){
     const restored={...saved,prepared:saved.root.prepared,signature:saved.root.signature,root:undefined};
     save(run,restored);
     notifyPositionHistoryChange(restored.prepared.summary.positionMint,restored.signature);
     saved=restored;
    }else if(result.status==="pending"){
     await waitFor(run,saved);
    }else{
     throw new Error(`Transaction status: ${result.status}. Review it before starting another withdrawal.`);
    }
   }else{
    await waitFor(run,saved);
   }
   if(saved.prepared.summary.stage==="withdraw"){
    guardRun(run);
    setProgress("Step 1 of 2 complete. Preparing conversion…");
    const nextRequest={...saved.request,stage:"swap",previous:saved.prepared,tx1Signature:saved.signature,confirmHighImpact:confirmed || saved.confirmHighImpact};
    const nextPreview=await post<WithdrawSummary>(run,"withdraw-quote",nextRequest);
    guardRun(run);setPreview(nextPreview);
    if(nextPreview.requiresSecondConfirmation && !nextRequest.confirmHighImpact){setConfirmation(true);setProgress("Confirm the conversion price impact to continue");return;}
    const prepared=await post<WithdrawPrepared>(run,"withdraw-prepare",nextRequest);
    saved=await signAndSend(run,prepared,confirmed || saved.confirmHighImpact,saved.request,{prepared:saved.prepared,signature:saved.signature});
    await waitFor(run,saved);
   }
   save(run,null);setProgress("Withdrawal complete");setPreview(null);currentOnConfirmed.current();
  }catch(caught){if(owns(run)){setProgress("");showError(caught,"Withdrawal failed");}}
  finally{finish(run);}
 }
 const disabled=busy || !!checkpoint || !!historyError;
 return <section aria-label="Withdraw from position" className="mt-4 rounded-3xl border border-white/20 bg-char p-5 text-cream">
  <div className="flex justify-between"><h2>Withdraw from position</h2><button disabled={disabled} onClick={onClose}>Close</button></div>
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
  {(historyError || error) && <p role="alert" className="mt-3 rounded-2xl border border-lemon/60 bg-lemon/10 p-3 text-sm text-lemon">{historyError || error}</p>}
  <p role="status" aria-live="polite" className="mt-3 text-sm text-smoke">{busy && <LoaderCircle aria-hidden className="mr-2 inline h-4 w-4 animate-spin" />}{progress}</p>
  {checkpoint ? <button disabled={busy || !!historyError} onClick={()=>{if(checkpoint.prepared.summary.requiresSecondConfirmation)setConfirmation(true);else void run();}} className="mt-3 rounded-full bg-lemon px-5 py-3 text-ink">Resume withdrawal</button> : error===WITHDRAW_EXPIRED_MESSAGE ? <button disabled={busy || !!historyError} onClick={()=>void run()} className="mt-3 rounded-full bg-lemon px-5 py-3 text-ink">Retry withdrawal</button> : <>
   <button type="button" disabled={busy || !!historyError} aria-busy={previewing} onClick={()=>void showPreview()} className="mt-3 rounded-full border px-5 py-3 disabled:opacity-50">{previewing?"Calculating…":"Preview"}</button>
   {/* Without a preview, Withdraw fetches one first so the tap is never silent; a second tap confirms. */}
   <button type="button" disabled={busy || !!historyError} aria-busy={busy && !previewing} onClick={()=>{if(!preview)void showPreview();else if(preview.requiresSecondConfirmation)setConfirmation(true);else void run();}} className="ml-3 rounded-full bg-lemon px-5 py-3 text-ink disabled:opacity-50">{busy && !previewing?"Withdrawing…":"Withdraw"}</button>
  </>}
  <dialog ref={confirmationRef} role="alertdialog" aria-label="Confirm high price impact" onCancel={event=>{event.preventDefault();setConfirmation(false);}} onClose={()=>setConfirmation(false)} className="fixed left-1/2 top-1/2 m-0 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-lemon bg-char p-5 text-cream backdrop:bg-black/70"><p>Price impact exceeds 5%. You may receive substantially less. Continue with this conversion?</p><button disabled={busy || !!historyError} onClick={()=>void run(true)} className="mt-3 rounded bg-lemon p-2 text-ink">Confirm high price impact</button><button onClick={()=>setConfirmation(false)} className="ml-3">Cancel</button></dialog>
 </section>;
}

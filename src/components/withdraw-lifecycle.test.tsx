// @vitest-environment happy-dom
import { act, Activity, StrictMode, Suspense, useEffect, useLayoutEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VersionedTransaction } from "@solana/web3.js";
import { WithdrawPanel } from "./withdraw-panel";
import { withdrawCheckpoint, withdrawKey, withdrawPosition, withdrawPrepared, withdrawSigner, withdrawWallet, signedWithdraw } from "@/lib/test-support/withdraw-checkpoint-fixtures";

const mocks = vi.hoisted(() => ({ sign: vi.fn(), notify: vi.fn(), confirmed: vi.fn(), busy: vi.fn() }));
vi.mock("./wallet-connection", () => ({ useWalletConnection: () => ({ address, connected, signTransaction: mocks.sign }) }));
vi.mock("@/lib/position-history-refresh", () => ({ notifyPositionHistoryChange: mocks.notify }));
let address: string | undefined, connected: boolean;
let root: Root, container: HTMLDivElement, mounted: boolean;
let first: ReturnType<typeof withdrawPrepared>, second: ReturnType<typeof withdrawPrepared>;
let events: { event: string; value?: unknown }[];
let cleanupDeferred: (()=>void)[];
const rawGet = Storage.prototype.getItem, rawSet = Storage.prototype.setItem, rawRemove = Storage.prototype.removeItem;
const raw = () => rawGet.call(localStorage, withdrawKey);
const record = (event: string, value?: unknown) => events.push({ event, value });
const calls = (phase: string) => events.filter(e => e.event === phase);
const count = () => Object.fromEntries(["quote", "prepare", "sign", "set", "remove", "broadcast", "status", "notify", "confirmed"].map(k => [k, calls(k).length]));
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: Error) => void; const promise = new Promise<T>((a,b) => { resolve=a; reject=b; }); void promise.catch(()=>undefined);cleanupDeferred.push(()=>reject(new Error("owned deferred cleanup")));return { promise, resolve, reject }; }
let network: (phase: string, body: Record<string, unknown>) => Promise<Response>;
function panel() { return <WithdrawPanel wallet={withdrawWallet} positionMint={withdrawPosition} mintA={withdrawPosition} mintB={withdrawWallet} label={m=>m} onClose={vi.fn()} onConfirmed={mocks.confirmed} onBusyChange={mocks.busy} />; }
async function render(node: ReactNode = panel()) { await act(async () => root.render(node)); }
function button(text: string) { return Array.from(container.querySelectorAll("button")).find(b=>b.textContent === text); }
async function click(text: string) { const b=button(text); expect(b, text).toBeDefined(); await act(async () => b!.click()); }
async function unmount() { if(mounted) { await act(async () => root.unmount()); mounted=false; } }
async function remount() { await unmount(); root=createRoot(container); mounted=true; await render(); }
async function start() { await render(); await click("Preview"); await click("Withdraw"); }
async function settle<T>(d: ReturnType<typeof deferred<T>>, value: T) { await act(async () => d.resolve(value)); }
function hold(phase: string, match: (body: Record<string, unknown>) => boolean = () => true, bodyOnly=false) {
 const d=deferred<unknown>(), previous=network; let used=false;
 network=async (p,b) => {
  if(p===phase && match(b) && !used) { used=true; return bodyOnly ? { ok:true, status:200, json:()=>d.promise } as Response : await d.promise as Response; }
  return previous(p,b);
 };
 return { ...d, release: async (value: unknown) => settle(d, bodyOnly ? value : Response.json(value)) };
}
function twoStage() { first=withdrawPrepared("withdraw"); second=withdrawPrepared("swap",{tx1Signature:signedWithdraw(first).signature}); }

it.each(["position", "wallet"] as const)("keeps uncertainty across retained %s ABA while the other identity stays live", async identity=>{
 const saved=withdrawCheckpoint("atomic");rawSet.call(localStorage,withdrawKey,JSON.stringify(saved));
 let failRead=false;
 vi.spyOn(localStorage,"getItem").mockImplementation(k=>{if(k===withdrawKey&&failRead){failRead=false;throw new Error("readback denied");}return rawGet.call(localStorage,k);});
 vi.mocked(localStorage.removeItem).mockImplementation(k=>{record("remove",k);rawRemove.call(localStorage,k);if(k===withdrawKey)failRead=true;});
 await render();await click("Resume withdrawal");
 expect(raw()).toBeNull();expect(button("Resume withdrawal")!.disabled).toBe(true);expect(mocks.confirmed).not.toHaveBeenCalled();
 vi.mocked(localStorage.removeItem).mockImplementation(k=>{record("remove",k);rawRemove.call(localStorage,k);});
 const wallet=identity==="wallet"?withdrawPosition:withdrawWallet,position=identity==="position"?withdrawWallet:withdrawPosition;
 const other=structuredClone(saved);other.request.wallet=wallet;other.request.positionMint=position;other.prepared.summary.wallet=wallet;other.prepared.summary.positionMint=position;
 const key=`sofinance:withdraw:${wallet}:${position}`;rawSet.call(localStorage,key,JSON.stringify(other));address=wallet;
 await render(<WithdrawPanel wallet={wallet} positionMint={position} mintA={withdrawPosition} mintB={withdrawWallet} label={m=>m} onClose={vi.fn()} onBusyChange={mocks.busy} onConfirmed={mocks.confirmed}/>);
 expect(button("Resume withdrawal")!.disabled).toBe(false);await click("Resume withdrawal");
 expect(rawGet.call(localStorage,key)).toBeNull();expect(mocks.confirmed).toHaveBeenCalledOnce();
 address=withdrawWallet;await render();
 expect(button("Resume withdrawal")?.disabled).toBe(true);
 expect(container.textContent).toContain("reload to check the saved transaction");
 const before=count();await click("Resume withdrawal");expect(count()).toEqual(before);expect(raw()).toBeNull();
 expect(calls("prepare")).toHaveLength(0);expect(calls("broadcast")).toHaveLength(0);
 // The latch belongs to this retained instance, not a global lock or a storage migration.
 await remount();await click("Preview");await click("Withdraw");expect(mocks.confirmed).toHaveBeenCalledTimes(2);
});

it.each(["atomic", "swap"] as const)("expiry message describes only the expired %s stage",async stage=>{
 if(stage==="swap")twoStage();
 const normal=network;network=async(p,b)=>p==="status"&&(b.prepared as {summary:{stage:string}}).summary.stage===stage?Response.json({status:"expired"}):normal(p,b);
 await start();
 if(stage==="atomic"){
  expect(raw()).toBeNull();expect(mocks.notify).not.toHaveBeenCalled();expect(button("Retry withdrawal")?.disabled).toBe(false);
  expect(container.textContent).toContain("no funds moved");
 }else{
  expect(mocks.notify).toHaveBeenCalledWith(withdrawPosition,signedWithdraw(first).signature);
  const saved=JSON.parse(raw()!);expect(saved.signature).toBe(signedWithdraw(first).signature);expect(saved.prepared).toEqual(first);
  expect(container.textContent).not.toContain("no funds moved");expect(container.textContent).toContain("Conversion expired. Resume to verify the original withdrawal and retry conversion.");
  expect(button("Resume withdrawal")?.disabled).toBe(false);expect(button("Retry withdrawal")).toBeUndefined();
  network=normal;await click("Resume withdrawal");
  expect(calls("prepare").map(e=>(e.value as {stage?:string}).stage)).toEqual([undefined,"swap","swap"]);
  expect(mocks.confirmed).toHaveBeenCalledOnce();expect(raw()).toBeNull();
 }
});
beforeEach(() => {
 vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-27T14:00:00Z"));
 localStorage.clear(); vi.resetAllMocks(); address=withdrawWallet; connected=true; events=[];cleanupDeferred=[];
 first=withdrawPrepared(); second=withdrawPrepared("swap");
 container=document.createElement("div");document.body.append(container); root=createRoot(container);mounted=true;
 (globalThis as unknown as Record<string,unknown>).IS_REACT_ACT_ENVIRONMENT=true;
 vi.spyOn(HTMLDialogElement.prototype,"showModal").mockImplementation(function(this:HTMLDialogElement){this.setAttribute("open","");});
 vi.spyOn(HTMLDialogElement.prototype,"close").mockImplementation(function(this:HTMLDialogElement){this.removeAttribute("open");});
 vi.spyOn(localStorage,"setItem").mockImplementation((k,v)=>{record("set",{key:k,raw:v});rawSet.call(localStorage,k,v);});
 vi.spyOn(localStorage,"removeItem").mockImplementation(k=>{record("remove",k);rawRemove.call(localStorage,k);});
 mocks.sign.mockImplementation(async (tx:VersionedTransaction)=>{record("sign",Array.from(tx.message.serialize()));tx.sign([withdrawSigner]);return tx;});
 mocks.notify.mockImplementation((...args)=>record("notify",args));mocks.confirmed.mockImplementation(()=>record("confirmed"));
 network=async (phase,b)=>{
  if(phase==="quote")return Response.json((b.stage==="swap"?second:first).summary);
  if(phase==="prepare")return Response.json(b.stage==="swap"?second:first);
  if(phase==="broadcast")return Response.json({accepted:true});
  if(phase==="status")return Response.json({status:"success"});
  throw new Error(`Unexpected request ${phase}`);
 };
 vi.stubGlobal("fetch",vi.fn(async (url:string,init:RequestInit)=>{expect(url).toMatch(/^\/api\/withdraw-(quote|prepare|broadcast|status)$/);const phase=url.slice("/api/withdraw-".length),body=JSON.parse(init.body as string);record(phase,body);return network(phase,body);}));
});
afterEach(async context=>{
 await unmount();await act(async()=>{cleanupDeferred.forEach(reject=>reject());});container.remove();
 expect(vi.getTimerCount()).toBe(0);
 // eslint-disable-next-line no-console -- Disposable synthetic fixture evidence, no product network or credentials.
 console.info(JSON.stringify({case:context.task.name,key:withdrawKey,raw:raw(),events,counts:count(),timers:vi.getTimerCount()}));
 vi.restoreAllMocks();vi.unstubAllGlobals();vi.clearAllTimers();vi.useRealTimers();
});

it.each(["prepare","sign","status"])("RED: true unmount during %s cannot advance the old run; genuine remount is live",async phase=>{
 if(phase==="status")twoStage();
 const wallet=deferred<VersionedTransaction>();
 const gate=phase==="sign"?null:hold(phase);
 if(phase==="sign")mocks.sign.mockImplementation(tx=>{record("sign",Array.from(tx.message.serialize()));return wallet.promise;});
 await start(); const before=count(),original=raw();record("before-unmount",before);
 await unmount();
 if(phase==="sign")await settle(wallet,signedWithdraw(first).transaction);
 else await gate!.release(phase==="status"?{status:"success"}:first);
 record("after-release",count());
 expect(count()).toEqual(before);expect(raw()).toBe(original);expect(mocks.notify).not.toHaveBeenCalled();expect(mocks.confirmed).not.toHaveBeenCalled();
 mocks.sign.mockImplementation(async tx=>{record("sign");tx.sign([withdrawSigner]);return tx;});
 await remount();
 if(original)await click("Resume withdrawal");else {await click("Preview");await click("Withdraw");}
 expect(mocks.confirmed).toHaveBeenCalledOnce();expect(raw()).toBeNull();
 if(original){expect((calls("status")[1]!.value as {signature:string}).signature).toBe(JSON.parse(original).signature);expect(calls("prepare").map(e=>(e.value as {stage?:string}).stage)).toEqual([undefined,"swap"]);}
});
it.each(["prepare","sign","status"])("live paired %s wait completes with exact original signature and payload",async phase=>{
 if(phase==="status")twoStage();
 const wallet=deferred<VersionedTransaction>();const gate=phase==="sign"?null:hold(phase);
 if(phase==="sign")mocks.sign.mockImplementation(tx=>{record("sign",Array.from(tx.message.serialize()));return wallet.promise;});
 await start();
 if(phase==="sign")await settle(wallet,signedWithdraw(first).transaction);else await gate!.release(phase==="status"?{status:"success"}:first);
 expect(mocks.confirmed).toHaveBeenCalledOnce();expect(raw()).toBeNull();
 expect(calls("broadcast")).toHaveLength(phase==="status"?2:1);
 const saved=JSON.parse((calls("set")[0]!.value as {raw:string}).raw);
 expect(saved.prepared).toEqual(first);expect(saved.signature).toBe(signedWithdraw(first).signature);
 expect(events.indexOf(calls("set")[0]!)).toBeLessThan(events.indexOf(calls("broadcast")[0]!));
 expect(mocks.notify).toHaveBeenCalledWith(withdrawPosition,saved.signature);
});

const boundaries=["quote", "quote-body", "prepare-body", "refresh", "refresh-body", "swap-quote", "swap-quote-body", "swap-prepare", "swap-prepare-body", "swap-refresh", "swap-refresh-body", "swap-sign", "swap-broadcast", "swap-broadcast-body", "broadcast", "broadcast-body"] as const;
type Boundary=typeof boundaries[number];
async function boundaryStart(boundary: Boundary) {
 if(boundary.startsWith("swap"))twoStage();
 let prepared=first;
 if(boundary==="swap-sign") {
  const wallet=deferred<VersionedTransaction>();let n=0;
  mocks.sign.mockImplementation(async tx=>{record("sign",Array.from(tx.message.serialize()));if(++n===2)return wallet.promise;tx.sign([withdrawSigner]);return tx;});
  await start();return {release:()=>settle(wallet,signedWithdraw(second).transaction)};
 }
 const phase=boundary.replace("swap-","").replace("-body","");
 let gate:ReturnType<typeof hold>;
 if(phase==="refresh") {
  const isSwap=boundary.startsWith("swap"), ordinal=isSwap?3:2;
  gate=hold("prepare",()=>calls("prepare").length===ordinal,boundary.endsWith("body"));
  const normal=network; const stale=withdrawPrepared(isSwap?"swap":"atomic",{expiresAt:Date.now()-1,...(isSwap?{tx1Signature:signedWithdraw(first).signature}:{})});
  network=async (p,b)=>p==="prepare"&&calls("prepare").length===ordinal-1?Response.json(stale):normal(p,b);
 }else gate=hold(phase,b=>!boundary.startsWith("swap")||b.stage==="swap"||(b.summary as {stage?:string}|undefined)?.stage==="swap",boundary.endsWith("body"));
 if(boundary.startsWith("swap"))prepared=second;
 await start();
 return { release:()=>gate.release(phase==="quote"?prepared.summary:phase==="broadcast"?{accepted:true}:prepared) };
}
it.each(boundaries)("unmount at %s stops every later command; explicit remount recovers",async boundary=>{
 const gate=await boundaryStart(boundary),before=count(),original=raw();
 await unmount();expect(vi.getTimerCount()).toBe(0);await gate.release();
 expect(count()).toEqual(before);expect(raw()).toBe(original);
 await remount();
 // Discarded preview has to be requested explicitly; persisted work only queries the old signature.
 if(original)await click("Resume withdrawal");else {await click("Preview");await click("Withdraw");}
 expect(mocks.confirmed).toHaveBeenCalledOnce();expect(raw()).toBeNull();
 if(original)expect((calls("status").at(-1)!.value as {signature:string}).signature).toBe(boundary.startsWith("swap")?signedWithdraw(second).signature:JSON.parse(original).signature);
 if(original && JSON.parse(original).prepared.summary.stage!=="withdraw"){expect(calls("sign")).toHaveLength(before.sign!);expect(calls("broadcast")).toHaveLength(before.broadcast!);expect(calls("prepare")).toHaveLength(before.prepare!);}
});
it.each(boundaries)("paired live %s still completes",async boundary=>{
 const gate=await boundaryStart(boundary);await gate.release();
 if(boundary.startsWith("quote"))await click("Withdraw");
 expect(mocks.confirmed).toHaveBeenCalledOnce();expect(raw()).toBeNull();
 expect(calls("broadcast")).toHaveLength(boundary.startsWith("swap")?2:1);
 if(boundary.startsWith("swap")){
  const s2=JSON.parse((calls("set")[1]!.value as {raw:string}).raw);
  expect(s2.root).toEqual({prepared:first,signature:signedWithdraw(first).signature});expect(s2.prepared).toEqual(second);
  expect(calls("prepare").slice(1).every(e=>JSON.stringify((e.value as {previous:unknown}).previous)===JSON.stringify(first))).toBe(true);
 }
 expect(vi.getTimerCount()).toBe(0);
});

it.each(["atomic","withdraw","swap"] as const)("canceled %s status success/failed/expired cannot mutate a new panel checkpoint",async stage=>{
 // Three separate old roots are exercised against a new mounted panel, using actual complete checkpoint bytes.
 for(const status of ["success","failed","expired"]){
  await unmount();const saved=withdrawCheckpoint(stage);rawSet.call(localStorage,withdrawKey,JSON.stringify(saved));
  await remount();const gate=hold("status",()=>true,true);await click("Resume withdrawal");
  await unmount();const newer=withdrawCheckpoint("atomic");newer.prepared.summary.expiresAt+=1000;
  const newerRaw=JSON.stringify(newer);rawSet.call(localStorage,withdrawKey,newerRaw);await remount();
  const before=count();await gate.release({status});expect(count()).toEqual(before);expect(raw()).toBe(newerRaw);
  expect(button("Resume withdrawal")!.disabled).toBe(false);
  await click("Resume withdrawal");expect(raw()).toBeNull();
 }
 expect(mocks.confirmed).toHaveBeenCalledTimes(3);
});
it.each(["failed","expired","manual-review","success"])("live status body %s retains existing finality and root behavior",async status=>{
 const saved=withdrawCheckpoint("swap"),original=JSON.stringify(saved);rawSet.call(localStorage,withdrawKey,original);
 const gate=hold("status",()=>true,true);await render();await click("Resume withdrawal");await gate.release({status});
 if(status==="success"){expect(raw()).toBeNull();expect(mocks.confirmed).toHaveBeenCalledOnce();
  expect(calls("prepare")).toHaveLength(0);expect(mocks.sign).not.toHaveBeenCalled();expect(calls("broadcast")).toHaveLength(0);}
 else if(status==="manual-review"){expect(raw()).toBe(original);
  expect(calls("prepare")).toHaveLength(0);expect(mocks.sign).not.toHaveBeenCalled();expect(calls("broadcast")).toHaveLength(0);}
 else {
  expect(raw()).toBeNull();expect(mocks.confirmed).toHaveBeenCalledOnce();
  expect(calls("prepare").some(e=>(e.value as {stage?:string}).stage==="swap")).toBe(true);
  expect(mocks.sign).toHaveBeenCalled();expect(calls("broadcast")).toHaveLength(1);
 }
});
it.each([false,true])("pending delay cancellation=%s owns and clears its timer",async cancel=>{
 twoStage();const saved=withdrawCheckpoint("withdraw");rawSet.call(localStorage,withdrawKey,JSON.stringify(saved));
 const normal=network;network=async(p,b)=>p==="status"&&calls("status").length===1?Response.json({status:"pending"}):normal(p,b);
 await render();await click("Resume withdrawal");expect(vi.getTimerCount()).toBe(1);expect(calls("quote")).toHaveLength(0);
 if(cancel){await unmount();expect(vi.getTimerCount()).toBe(0);}
 await act(async()=>vi.advanceTimersByTimeAsync(2000));
 if(cancel){expect(calls("status")).toHaveLength(1);expect(raw()).toBe(JSON.stringify(saved));await remount();expect(calls("status")).toHaveLength(1);await click("Resume withdrawal");}
 expect(mocks.confirmed).toHaveBeenCalledOnce();expect(calls("prepare")).toHaveLength(1);expect(mocks.sign).toHaveBeenCalledOnce();
 expect(vi.getTimerCount()).toBe(0);
});

// Real React disconnect mechanisms. Suspense removes layout effects only; Activity
// removes both kinds, retaining refs/state. Neither wrapper exists in product code.
async function retained(kind:"activity"|"suspense") {
 const blocker=deferred<void>();const effects={layout:0,layoutCleanup:0,passive:0,passiveCleanup:0};
 function Tracked(){useLayoutEffect(()=>{effects.layout++;return()=>{effects.layoutCleanup++;};},[]);useEffect(()=>{effects.passive++;return()=>{effects.passiveCleanup++;};},[]);return panel();}
 function Suspend({hide}:{hide:boolean}){if(hide)throw blocker.promise;return null;}
 const draw=async(hide:boolean)=>render(kind==="activity"?<Activity mode={hide?"hidden":"visible"}><Tracked/></Activity>:<Suspense fallback={<p>loading</p>}><Tracked/><Suspend hide={hide}/></Suspense>);
 await draw(false);
 return {draw,effects,release:()=>settle(blocker,undefined)};
}
const retainedCases=(["activity","suspense"] as const).flatMap(kind=>(["prepare","sign"] as const).flatMap(phase=>(["resolve","reject"] as const).flatMap(outcome=>(["before","after"] as const).map(settlement=>({kind,phase,outcome,settlement})))));
it.each(retainedCases)("$kind $phase $outcome settles $settlement reconnect: no stale work, no duplicate prompt, no permanent busy",async({kind,phase,outcome,settlement})=>{
 const view=await retained(kind),wallet=deferred<VersionedTransaction>(),gate=phase==="prepare"?hold("prepare"):null;
 if(phase==="sign")mocks.sign.mockImplementation(tx=>{record("sign",Array.from(tx.message.serialize()));return wallet.promise;});
 await click("Preview");await click("Withdraw");const before=count();await view.draw(true);
 expect(view.effects).toEqual({layout:1,layoutCleanup:1,passive:1,passiveCleanup:kind==="activity"?1:0});
 const release=async()=>{
  if(outcome==="reject")await act(async()=>{(gate??wallet).reject(new Error("late failure"));});
  else if(gate)await gate.release(first);else await settle(wallet,signedWithdraw(first).transaction);
 };
 if(settlement==="before")await release();
 await view.draw(false);await view.release();
 if(settlement==="after"){
  // New committed lifetime must keep the unresolved old promise locked.
  expect(button("Withdrawing…")!.disabled).toBe(true);await click("Withdrawing…");expect(count()).toEqual(before);await release();
 }
 expect(count()).toEqual(before);expect(raw()).toBeNull();expect(button("Withdraw")!.disabled).toBe(false);
 expect(container.textContent).not.toContain("late failure");
 mocks.sign.mockImplementation(async tx=>{record("sign");tx.sign([withdrawSigner]);return tx;});
 await click("Preview");await click("Withdraw");expect(mocks.confirmed).toHaveBeenCalledOnce();expect(raw()).toBeNull();expect(vi.getTimerCount()).toBe(0);
});
it.each((["activity","suspense"] as const).flatMap(kind=>(["before","after"] as const).flatMap(settlement=>(["atomic","swap"] as const).map(stage=>({kind,settlement,stage})))))("$kind durable $stage unknown settles $settlement reconnect: Resume queries original signature, zero resend",async({kind,settlement,stage})=>{
 if(stage==="swap")twoStage();
 const view=await retained(kind),gate=hold("broadcast",b=>(b.summary as {stage:string}).stage===stage);
 await click("Preview");await click("Withdraw");const original=raw()!,saved=JSON.parse(original),before=count();
 expect(saved.prepared.summary.stage).toBe(stage);if(stage==="swap")expect(saved.root).toEqual({prepared:first,signature:signedWithdraw(first).signature});
 await view.draw(true);
 if(settlement==="before")await act(async()=>gate.reject(new Error("lost response")));
 await view.draw(false);await view.release();
 if(settlement==="after"){expect(button("Resume withdrawal")!.disabled).toBe(true);await act(async()=>gate.reject(new Error("lost response")));}
 expect(count()).toEqual(before);expect(raw()).toBe(original);expect(button("Resume withdrawal")!.disabled).toBe(false);
 await click("Resume withdrawal");expect(calls("broadcast")).toHaveLength(before.broadcast!);expect(calls("sign")).toHaveLength(before.sign!);
 expect(calls("status").at(-1)!.value).toEqual({signature:saved.signature,prepared:saved.prepared});expect(raw()).toBeNull();expect(mocks.confirmed).toHaveBeenCalledOnce();
});

it.each(["prepare","sign"] as const)("StrictMode replay permits a healthy %s wait exactly once",async phase=>{
 const wallet=deferred<VersionedTransaction>(),gate=phase==="prepare"?hold("prepare"):null;
 if(phase==="sign")mocks.sign.mockImplementation(tx=>{record("sign",Array.from(tx.message.serialize()));return wallet.promise;});
 await render(<StrictMode>{panel()}</StrictMode>);await click("Preview");await click("Withdraw");
 if(gate)await gate.release(first);else await settle(wallet,signedWithdraw(first).transaction);
 expect(calls("prepare")).toHaveLength(1);expect(calls("sign")).toHaveLength(1);expect(calls("broadcast")).toHaveLength(1);expect(mocks.confirmed).toHaveBeenCalledOnce();
});
it.each(["AB","ABA","disconnect"] as const)("retained committed connection %s cancels wallet result; fresh explicit run is live",async change=>{
 const wallet=deferred<VersionedTransaction>();mocks.sign.mockImplementation(tx=>{record("sign",Array.from(tx.message.serialize()));return wallet.promise;});
 await start();const before=count();
 address=change==="disconnect"?undefined:withdrawPosition;connected=change!=="disconnect";await render();
 if(change==="ABA"){address=withdrawWallet;await render();}
 await settle(wallet,signedWithdraw(first).transaction);expect(count()).toEqual(before);expect(raw()).toBeNull();
 address=withdrawWallet;connected=true;await render();
 mocks.sign.mockImplementation(async tx=>{record("sign");tx.sign([withdrawSigner]);return tx;});
 await click("Preview");await click("Withdraw");expect(mocks.confirmed).toHaveBeenCalledOnce();
});
it("current connection identity is checked after prepare, before any wallet prompt",async()=>{
 const gate=hold("prepare");await start();address=withdrawPosition;await render();await gate.release(first);
 expect(calls("sign")).toHaveLength(0);expect(calls("broadcast")).toHaveLength(0);
 address=withdrawWallet;await render();await click("Preview");await click("Withdraw");expect(mocks.confirmed).toHaveBeenCalledOnce();
});
it("unrelated rerenders and new callback/connection object identities do not invalidate healthy work",async()=>{
 const gate=hold("prepare");await start();await render();await render();await gate.release(first);expect(mocks.confirmed).toHaveBeenCalledOnce();expect(calls("prepare")).toHaveLength(1);
});
it.each(["atomic","swap"] as const)("%s wallet expiry is checked after approval without re-signing; healthy wait still completes",async stage=>{
 if(stage==="swap")twoStage();
 const wallet=deferred<VersionedTransaction>();let signed=0;
 mocks.sign.mockImplementation(async tx=>{record("sign",Array.from(tx.message.serialize()));if(++signed===(stage==="swap"?2:1))return wallet.promise;tx.sign([withdrawSigner]);return tx;});
 await start();const original=raw(),before=count();
 await act(async()=>vi.advanceTimersByTimeAsync(60_000));await settle(wallet,signedWithdraw(stage==="swap"?second:first).transaction);
 expect(count()).toEqual(before);expect(raw()).toBe(original);expect(container.textContent).toContain("expired while awaiting wallet approval");
 expect(container.textContent).not.toContain("no funds moved");
 // New explicit user action may prepare a fresh transaction; original principal is never repeated for swap.
 first=withdrawPrepared(stage==="swap"?"withdraw":"atomic");second=withdrawPrepared("swap",{tx1Signature:signedWithdraw(first).signature});
 const valid=deferred<VersionedTransaction>();mocks.sign.mockImplementation(tx=>{record("sign",Array.from(tx.message.serialize()));return valid.promise;});
 if(stage==="swap")await click("Resume withdrawal");else {await click("Preview");await click("Withdraw");}
 await act(async()=>vi.advanceTimersByTimeAsync(50_000));await settle(valid,signedWithdraw(stage==="swap"?second:first).transaction);
 expect(mocks.confirmed).toHaveBeenCalledOnce();expect(raw()).toBeNull();
 if(stage==="swap")expect(calls("prepare").map(e=>(e.value as {stage?:string}).stage)).toEqual([undefined,"swap","swap"]);
});
it.each(["atomic","swap"] as const)("high-impact %s dialog cancel and reconnect keep consent explicit",async stage=>{
 if(stage==="swap")twoStage();
 const prepared=stage==="swap"?second:first;prepared.summary.requiresSecondConfirmation=true;
 const view=await retained("suspense");await click("Preview");await click("Withdraw");
 expect(container.querySelector("dialog")!.open).toBe(true);const before=count(),original=raw();
 await click("Cancel");expect(count()).toEqual(before);expect(raw()).toBe(original);
 if(stage==="swap")await click("Resume withdrawal");else await click("Withdraw");
 await view.draw(true);await view.draw(false);await view.release();expect(container.querySelector("dialog")!.open).toBe(false);
 expect(calls("sign")).toHaveLength(stage==="swap"?1:0);
 if(stage==="swap")await click("Resume withdrawal");else {await click("Preview");await click("Withdraw");}
 await click("Confirm high price impact");expect(mocks.confirmed).toHaveBeenCalledOnce();expect(raw()).toBeNull();
 expect((calls("prepare").at(-1)!.value as {confirmHighImpact:boolean}).confirmHighImpact).toBe(true);
});
it.each(["changed","unavailable","rootless"] as const)("cancel then Resume never masks %s history uncertainty",async mode=>{
 const saved=withdrawCheckpoint("swap"),original=JSON.stringify(saved);rawSet.call(localStorage,withdrawKey,original);
 const gate=hold("status");await render();await click("Resume withdrawal");await unmount();
 const invalid=withdrawCheckpoint("swap");delete (invalid as {root?:unknown}).root;
 const replacement=mode==="rootless"?JSON.stringify(invalid):original+" ";rawSet.call(localStorage,withdrawKey,replacement);
 const get=mode==="unavailable"?vi.spyOn(localStorage,"getItem").mockImplementation(()=>{throw new Error("denied");}):null;
 await remount();await gate.release({status:"expired"});expect(raw()).toBe(replacement);
 // Unavailable/rootless are fail-closed at mount; changed bytes at a current run's await are tested by D2.
 if(mode!=="changed"){expect(button("Resume withdrawal")?.disabled??button("Withdraw")!.disabled).toBe(true);expect(calls("sign")).toHaveLength(0);expect(calls("broadcast")).toHaveLength(0);}
 else {await click("Resume withdrawal");expect(raw()).toBeNull();expect(mocks.confirmed).toHaveBeenCalledOnce();}
 get?.mockRestore();
});
it("healthy run uses the latest committed wallet callback and completion callback without cancellation",async()=>{
 const gate=hold("prepare");await start();const confirmed=vi.fn();
 const newerSigner=vi.fn(async(tx:VersionedTransaction)=>{record("sign");tx.sign([withdrawSigner]);return tx;});mocks.sign=newerSigner;
 await render(<WithdrawPanel wallet={withdrawWallet} positionMint={withdrawPosition} mintA={withdrawPosition} mintB={withdrawWallet} label={m=>m} onClose={vi.fn()} onConfirmed={confirmed} onBusyChange={vi.fn()}/>);
 await gate.release(first);expect(newerSigner).toHaveBeenCalledOnce();expect(confirmed).toHaveBeenCalledOnce();expect(mocks.confirmed).not.toHaveBeenCalled();
});
it("explicit Resume preserves target-only historical request with receive omitted across full swap refresh and checkpoint",async()=>{
 const request={wallet:withdrawWallet,positionMint:withdrawPosition,targetUSDC:12.34};
 const saved=withdrawCheckpoint("withdraw",request);rawSet.call(localStorage,withdrawKey,JSON.stringify(saved));
 first=saved.prepared;second=withdrawPrepared("swap",{tx1Signature:saved.signature});
 const normal=network;network=async(p,b)=>p==="prepare"&&calls("prepare").length===1?Response.json(withdrawPrepared("swap",{expiresAt:Date.now()-1,tx1Signature:saved.signature})):normal(p,b);
 const sent=hold("broadcast");await render();await click("Resume withdrawal");
 expect(calls("prepare")).toHaveLength(2);
 for(const e of [...calls("quote"),...calls("prepare")]){const body=e.value as Record<string,unknown>;expect(body).toMatchObject({...request,stage:"swap",previous:saved.prepared,tx1Signature:saved.signature});expect(body).not.toHaveProperty("receive");expect(body).not.toHaveProperty("percent");}
 const checkpoint=JSON.parse(raw()!);expect(checkpoint.request).toEqual(request);expect(checkpoint.root).toEqual({prepared:saved.prepared,signature:saved.signature});expect(checkpoint.prepared).toEqual(second);
 await sent.release({accepted:true});expect(mocks.confirmed).toHaveBeenCalledOnce();expect(raw()).toBeNull();
});
it("retained position prop change invalidates the old run and loads that position's own history",async()=>{
 const gate=hold("prepare");await start();
 const other=withdrawWallet;const key=`sofinance:withdraw:${withdrawWallet}:${other}`;
 const prepared=withdrawPrepared("atomic",{positionMint:other});const saved={prepared,signature:signedWithdraw(prepared).signature,request:{wallet:withdrawWallet,positionMint:other,percent:100},confirmHighImpact:false};
 rawSet.call(localStorage,key,JSON.stringify(saved));
 await render(<WithdrawPanel wallet={withdrawWallet} positionMint={other} mintA={withdrawPosition} mintB={withdrawWallet} label={m=>m} onClose={vi.fn()} onConfirmed={mocks.confirmed} onBusyChange={mocks.busy}/>);
 await gate.release(first);expect(calls("sign")).toHaveLength(0);expect(rawGet.call(localStorage,key)).toBe(JSON.stringify(saved));expect(button("Resume withdrawal")!.disabled).toBe(false);
 await click("Resume withdrawal");expect(calls("status")[0]!.value).toEqual({signature:saved.signature,prepared});expect(rawGet.call(localStorage,key)).toBeNull();expect(mocks.confirmed).toHaveBeenCalledOnce();
});

// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VersionedTransaction } from "@solana/web3.js";
import { SelectedApp } from "./selected-app";
import { WalletConnectionContext, type WalletConnection } from "./wallet-connection";
import { withdrawKey, withdrawPosition, withdrawPrepared, withdrawSigner, withdrawWallet, signedWithdraw } from "@/lib/test-support/withdraw-checkpoint-fixtures";
import { testKeypair } from "@/lib/test-support/send-fixtures";
import { USDC_MINT } from "@sofinance/engine/ids";

// Next router is the sole framework boundary; all three controllers, WithdrawPanel,
// ActionSelector and PositionSelect are real. Only wallet and HTTP are synthetic.
vi.mock("next/navigation",()=>({usePathname:()=>"/app"}));
let root:Root, container:HTMLDivElement;
let wallet:WalletConnection;
let pending:{resolve:(tx:VersionedTransaction)=>void;reject:(e:Error)=>void;promise:Promise<VersionedTransaction>};
let events:{path:string;body:Record<string,unknown>}[];
let prepare:ReturnType<typeof withdrawPrepared>;
let network:(path:string,body:Record<string,unknown>)=>Promise<Response>;
const otherPosition=testKeypair(81).publicKey.toBase58();
function state(positionMint:string,address=withdrawWallet){return {
 wallet:address,positionMint,inputMint:USDC_MINT,inputKind:"token",inputDecimals:6,inputBalance:"1000000",ownsNft:true,sufficientSol:true,unsupportedExtensions:[],
 mintA:USDC_MINT,mintB:withdrawWallet,decimalsA:6,decimalsB:9,currentAmounts:{a:"1000000",b:"1000000000"},balances:{a:"1000000",b:"1000000000"},
 solLamports:1000000000,price:"1",tickLower:0,tickUpper:10,slot:1,liquidity:"1000000",rangeSide:"inside",inRange:true,poolId:testKeypair(82).publicKey.toBase58(),
};}
async function render(){await act(async()=>root.render(<WalletConnectionContext.Provider value={wallet}><SelectedApp initialView="withdraw"/></WalletConnectionContext.Provider>));}
async function advance(ms=30){await act(async()=>vi.advanceTimersByTimeAsync(ms));}
async function ready(){await render();await advance();await advance();await advance();expect(container.querySelector('[aria-label="Withdraw from position"]')).not.toBeNull();}
async function click(text:string,selector="button"){
 const target=Array.from(container.querySelectorAll<HTMLButtonElement>(selector)).find(b=>b.textContent===text);expect(target,text).toBeDefined();expect(target!.disabled,text).toBe(false);await act(async()=>target!.click());
}
async function submit(){await click("Preview","#withdraw-view button");await click("Withdraw","#withdraw-view button");}
function requests(path:string){return events.filter(e=>e.path===`/api/withdraw-${path}`);}
function counts(){return Object.fromEntries(["prepare","broadcast","status"].map(p=>[p,requests(p).length]));}
beforeEach(()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-27T14:00:00Z"));vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);localStorage.clear();events=[];
 container=document.createElement("div");document.body.append(container);root=createRoot(container);prepare=withdrawPrepared();
 const promise=new Promise<VersionedTransaction>((resolve,reject)=>{pending={promise:null!,resolve,reject};});pending.promise=promise;void promise.catch(()=>undefined);
 wallet={address:withdrawWallet,connected:true,connect:vi.fn(),disconnect:vi.fn(),isMobile:false,walletsCount:1,connectionError:"",signTransaction:vi.fn(()=>pending.promise)};
 vi.spyOn(HTMLDialogElement.prototype,"showModal").mockImplementation(function(this:HTMLDialogElement){this.setAttribute("open","");});
 vi.spyOn(HTMLDialogElement.prototype,"close").mockImplementation(function(this:HTMLDialogElement){this.removeAttribute("open");});
 network=async(path,body)=>{
  if(path.startsWith("/api/wallet?"))return Response.json({wallet:wallet.address,positions:[withdrawPosition,otherPosition].map(positionMint=>({...state(positionMint),nftAccount:testKeypair(83).publicKey.toBase58()})),assets:[{kind:"token",mint:USDC_MINT,balance:"1000000",totalBalance:"1000000",decimals:6,eligible:true,symbol:"USDC"}]});
  if(path.startsWith("/api/selected-state?")){const params=new URLSearchParams(path.split("?")[1]);return Response.json(state(params.get("positionMint")!,params.get("wallet")!));}
  if(path==="/api/compound-state")return Response.json({error:"No compound preview in this withdrawal fixture"},{status:400});
  if(path==="/api/token-metadata")return Response.json({tokens:{}});
  if(path==="/api/sol-usdc-price")return Response.json({rate:100,usdcUsd:1});
  if(path==="/api/withdraw-quote"||path==="/api/withdraw-prepare"){
   const value=withdrawPrepared("atomic",{positionMint:body.positionMint as string});prepare=value;
   return Response.json(path.endsWith("quote")?value.summary:value);
  }
  if(path==="/api/withdraw-broadcast")return Response.json({accepted:true});
  if(path==="/api/withdraw-status")return Response.json({status:"success"});
  throw new Error(`Unexpected network ${path}`);
 };
 vi.stubGlobal("fetch",vi.fn(async(path:string,init?:RequestInit)=>{const body=init?.body?JSON.parse(init.body as string):{};events.push({path,body});return network(path,body);}));
});
afterEach(async context=>{
 await act(async()=>root.unmount());await act(async()=>pending.reject(new Error("owned test cleanup")));container.remove();
 // eslint-disable-next-line no-console -- Synthetic actual-caller request ledger; no wallet/provider traffic.
 console.info(JSON.stringify({case:context.task.name,events,withdrawCounts:counts(),signature:signedWithdraw(prepare).signature,raw:localStorage.getItem(withdrawKey)}));
 vi.restoreAllMocks();vi.unstubAllGlobals();vi.clearAllTimers();vi.useRealTimers();
});
it("actual action navigation unmounts pending wallet; new panel remains usable without a stale send",async()=>{
 await ready();await submit();expect(wallet.signTransaction).toHaveBeenCalledOnce();const before=counts();
 expect((container.querySelector('#withdraw-view button') as HTMLButtonElement).disabled).toBe(true); // Close
 await click("Add to position","nav[aria-label='Position operations'] button");expect(container.querySelector("#withdraw-view")).toBeNull();
 await act(async()=>pending.resolve(signedWithdraw(prepare).transaction));expect(counts()).toEqual(before);expect(localStorage.getItem(withdrawKey)).toBeNull();
 wallet={...wallet,signTransaction:vi.fn(async tx=>{tx.sign([withdrawSigner]);return tx;})};await render();
 await click("Withdraw","nav[aria-label='Position operations'] button");await submit();
 expect(requests("broadcast")).toHaveLength(1);expect(requests("status")).toHaveLength(1);expect(container.textContent).toContain("Withdrawal complete");
});
it("actual position selection after leaving withdrawal mounts a new keyed panel; old rejection cannot clear new checkpoint",async()=>{
 await ready();await submit();const old=prepare;
 await click("Add to position","nav[aria-label='Position operations'] button");
 const selector=container.querySelector<HTMLSelectElement>("#position")!;expect(selector.disabled).toBe(false);
 await act(async()=>{selector.value=otherPosition;selector.dispatchEvent(new Event("change",{bubbles:true}));});await advance();await advance();
 wallet={...wallet,signTransaction:vi.fn(async tx=>{tx.sign([withdrawSigner]);return tx;})};await render();
 const normal=network;network=async(path,body)=>path==="/api/withdraw-broadcast"?Promise.reject(new Error("lost reply")):normal(path,body);
 await click("Withdraw","nav[aria-label='Position operations'] button");await submit();
 const key=`sofinance:withdraw:${withdrawWallet}:${otherPosition}`,original=localStorage.getItem(key);expect(original).not.toBeNull();expect(JSON.parse(original!).prepared.summary.positionMint).toBe(otherPosition);
 const before=counts();await act(async()=>pending.reject(new Error("old wallet rejected")));
 expect(counts()).toEqual(before);expect(localStorage.getItem(key)).toBe(original);expect(localStorage.getItem(withdrawKey)).toBeNull();expect(container.textContent).not.toContain("old wallet rejected");
 expect(requests("prepare").map(e=>e.body.positionMint)).toEqual([withdrawPosition,otherPosition]);
 network=normal;await click("Resume withdrawal","#withdraw-view button");expect(localStorage.getItem(key)).toBeNull();expect(requests("broadcast")).toHaveLength(1);
 expect(signedWithdraw(old).signature).toBe(JSON.parse(original!).signature); // Synthetic fixture message is deliberately identical; key/summary scopes differ.
});
it("actual action remount preserves an unknown durable send and only queries its original signature",async()=>{
 wallet={...wallet,signTransaction:vi.fn(async tx=>{tx.sign([withdrawSigner]);return tx;})};
 let release!:(r:Response)=>void;const sent=new Promise<Response>(r=>{release=r;});const normal=network;
 network=async(path,body)=>path==="/api/withdraw-broadcast"?sent:normal(path,body);
 await ready();await submit();const original=localStorage.getItem(withdrawKey)!,saved=JSON.parse(original);expect(saved.signature).toBe(signedWithdraw(prepare).signature);
 await click("Add to position","nav[aria-label='Position operations'] button");await act(async()=>release(Response.json({accepted:true})));
 expect(localStorage.getItem(withdrawKey)).toBe(original);expect(requests("status")).toHaveLength(0);
 await click("Withdraw","nav[aria-label='Position operations'] button");expect(requests("status")).toHaveLength(0);await click("Resume withdrawal","#withdraw-view button");
 expect(requests("status")[0]!.body).toEqual({signature:saved.signature,prepared:saved.prepared});expect(wallet.signTransaction).toHaveBeenCalledOnce();expect(requests("broadcast")).toHaveLength(1);expect(localStorage.getItem(withdrawKey)).toBeNull();
});

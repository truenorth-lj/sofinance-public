// @vitest-environment happy-dom
import {act,createElement} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {LpPositionEvidence} from "./lp-position-evidence";
let root:Root,node:HTMLDivElement;
const nft="DemoPosition1111111111111111111111111111111";
const click=(text:string)=>{const button=[...node.querySelectorAll("button")].find(b=>b.textContent?.includes(text));if(!button)throw Error(text);button.click();};
const vector=()=>({status:"verified-preview",executable:false,sent:false,recoveryUSDCAtomic:"1000000",recoverySOLLamports:"8580200",networkAndPriorityLamports:"5000",observedAt:new Date(Date.now()).toISOString(),localExpiresAt:new Date(Date.now()+15000).toISOString(),bytes:1123});
beforeEach(async()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);node=document.createElement("div");document.body.append(node);root=createRoot(node);await act(async()=>root.render(createElement(LpPositionEvidence,{positionId:nft})));});
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.useRealTimers();vi.unstubAllGlobals();});
it("shows actual vector, included costs and SOL risk, suppresses duplicate clicks and expires",async()=>{
 vi.useFakeTimers();const fetcher=vi.fn().mockResolvedValue(Response.json(vector()));vi.stubGlobal("fetch",fetcher);
 await act(async()=>{click("Preview exit");click("Preview exit");});expect(fetcher).toHaveBeenCalledTimes(1);expect(node.textContent).toContain("1.000000 USDC + 0.008580200 SOL");expect(node.textContent).toContain("not deducted again");expect(node.textContent).toContain("SOL keeps its price exposure");
 await act(async()=>vi.advanceTimersByTime(16000));expect(node.textContent).toContain("Exit preview expired");
});
it("explains when a combined exit exceeds the 1232-byte packet limit",async()=>{
 const fetcher=vi.fn().mockResolvedValue(Response.json({status:"unavailable",reason:"Full atomic exit exceeds 1232 bytes: 1480",bytes:1480,executable:false,sent:false,received:[{mint:"So11111111111111111111111111111111111111112",amountAtomic:"1000"}]}));
 vi.stubGlobal("fetch",fetcher);await act(async()=>click("Preview exit"));
 expect(node.textContent).toContain("cannot fit in one Solana transaction");expect(node.textContent).toContain("1480");expect(node.textContent).toContain("separate vectors");
});
it("cancels transports ignoring abort and clears stale result, permits retry",async()=>{
 let resolve!:(value:Response)=>void;const fetcher=vi.fn((url:string,options:RequestInit)=>{void url;void options;return new Promise<Response>(r=>resolve=r);});vi.stubGlobal("fetch",fetcher);
 await act(async()=>click("Preview exit"));await act(async()=>click("Cancel"));expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
 await act(async()=>resolve(Response.json(vector())));expect(node.textContent).not.toContain("1.000000 USDC");
 fetcher.mockResolvedValueOnce(Response.json({error:"RPC 429"},{status:503}));await act(async()=>click("Preview exit"));expect(node.textContent).toContain("RPC 429");
});
it("refuses replay/demo as current ledger and cancels on unmount",async()=>{
 const fetcher=vi.fn().mockResolvedValue(Response.json({source:{kind:"captured-public",fresh:false,synthetic:false}}));vi.stubGlobal("fetch",fetcher);await act(async()=>click("Read ledger"));expect(node.textContent).toContain("Live ledger refuses demo or replayed sources");
 fetcher.mockImplementation((_url,init)=>new Promise((_resolve,reject)=>init.signal.addEventListener("abort",()=>reject(Error("aborted")))));await act(async()=>click("Preview exit"));await act(async()=>root.render(null));expect(fetcher.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
});
it("preserves priced partial ledger and resumes its cursor without treating wallet scope as a blocker",async()=>{
 const metric={lower:null,upper:null,value:null,status:"unavailable",missing:["opening window"],basis:"reference"};
 const data={source:{kind:"live",fresh:true,synthetic:false,asOf:new Date().toISOString()},nextCursor:"last-ok",historyReachedEnd:false,verifiedTransactionCount:10,errors:[{detail:"Public RPC HTTP 429"}],accounting:{historical:metric,hodl:metric,excess:metric,knownSubtotal:{lower:"-2",upper:"-1",label:"partial"},completeness:{positionAccounting:"partial",walletAccounting:"not-collected"},classification:{policy:"boundary",unknowns:[],crossTransactionCandidates:[]},pricePolicy:"prior minute",costs:[{id:"mixed",totalLamports:"20000",lowerLamports:"0",upperLamports:"20000",allocation:"shared bounds"}]}};
 const fetcher=vi.fn().mockResolvedValue(Response.json(data));vi.stubGlobal("fetch",fetcher);await act(async()=>click("Read ledger"));expect(node.textContent).toContain("-2.0000 to -1.0000");expect(node.textContent).toContain("Not a complete net result");expect(node.textContent).toContain("whole wallet not-collected (does not block position metrics)");expect(node.textContent).toContain("[0, 20000]");
 await act(async()=>click("Read ledger"));expect(fetcher.mock.calls[1]?.[0]).toContain("before=last-ok");
});

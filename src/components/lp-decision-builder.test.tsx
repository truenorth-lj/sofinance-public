// @vitest-environment happy-dom
import {act,createElement} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {LpDecisionBuilder} from "./lp-decision-builder";
it("the main return/cancel cancels the position evidence transport and rejects its late success",async()=>{
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
 let resolve!:(v:Response)=>void;const fetcher=vi.fn((_url:string,_options:RequestInit)=>{void _url;void _options;return new Promise<Response>(r=>resolve=r);});vi.stubGlobal("fetch",fetcher);
 try{await act(async()=>root.render(createElement(LpDecisionBuilder,{positionId:"DemoPosition1111111111111111111111111111111"})));
 const click=(text:string)=>{const b=[...node.querySelectorAll("button")].find(b=>b.textContent?.includes(text));if(!b)throw Error(text);b.click();};
 await act(async()=>click("預覽退出"));await act(async()=>click("返回／取消"));expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
 await act(async()=>resolve(Response.json({status:"verified-preview",sent:false,executable:false,recoveryUSDCAtomic:"1000000",recoverySOLLamports:"8580200",localExpiresAt:new Date(Date.now()+15000).toISOString()})));expect(node.textContent).not.toContain("1.000000 USDC");expect(node.textContent).toContain("預覽退出：USDC＋SOL");
 }finally{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals();}
});

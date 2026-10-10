// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useLpDecisionController } from "./use-lp-decision-controller";
let controller: ReturnType<typeof useLpDecisionController>;
function Harness() { const value = useLpDecisionController(); useEffect(() => { controller = value; }); return createElement("div",null,value.result?.requestId ?? value.error ?? "empty"); }
let root: Root; let node: HTMLDivElement;
const input = {asset:"USDC",numeraire:"USDC",decimals:6,amountAtomic:"1000000000",targetDate:"2026-11-09",demo:false} as const;
beforeEach(async()=>{ vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true); node = document.createElement("div"); document.body.append(node); root=createRoot(node); await act(async()=>root.render(createElement(Harness))); });
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals();});
it("handles real React state, duplicate submits, aborted stale success, and context-mismatched responses", async()=>{
  const pending: Array<(v: Response)=>void> = [];
  const fetchMock = vi.fn(()=>new Promise<Response>(resolve=>pending.push(resolve)));
  vi.stubGlobal("fetch",fetchMock);
  let old!: Promise<void>;
  await act(async()=>{old=controller.run(input);void controller.run(input);});
  expect(fetchMock).toHaveBeenCalledTimes(1); expect(controller.busy).toBe(true);
  await act(async()=>controller.cancel());
  let current!: Promise<void>; await act(async()=>{ current=controller.run({...input,amountAtomic:"2000000000"}); });
  await act(async()=>{pending[0]!(Response.json({requestId:"lp-1",contextVersion:1}));await old;});
  expect(controller.result).toBeNull(); expect(controller.busy).toBe(true);
  await act(async()=>{pending[1]!(Response.json({requestId:"lp-3",contextVersion:3}));await current;});
  expect(controller.result?.requestId).toBe("lp-3"); expect(controller.busy).toBe(false);
  let mismatch!: Promise<void>; await act(async()=>{mismatch=controller.run(input);});
  await act(async()=>{pending[2]!(Response.json({requestId:"lp-old",contextVersion:1}));await mismatch;});
  expect(controller.result).toBeNull(); expect(controller.error).toBe("Response context mismatch");
});
it("shows server errors and cancels pending work on unmount",async()=>{
  const fetchMock=vi.fn().mockResolvedValue(Response.json({error:"期限無效"},{status:400}));vi.stubGlobal("fetch",fetchMock);
  await act(async()=>{await controller.run(input);}); expect(controller.error).toBe("期限無效");
  fetchMock.mockImplementation((_url,options)=>new Promise((_resolve,reject)=>{options.signal.addEventListener("abort",()=>reject(new Error("aborted")));}));
  let job!: Promise<void>;await act(async()=>{job=controller.run(input);});
  await act(async()=>{root.render(null);}); await job; expect(fetchMock.mock.calls[1]![1].signal.aborted).toBe(true);
});

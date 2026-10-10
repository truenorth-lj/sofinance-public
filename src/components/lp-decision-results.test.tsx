import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { buildDecision } from "@/lib/lp-decision";
import { LpDecisionResults } from "./lp-decision-results";
const req = {requestId:"test",contextVersion:1,asset:"USDC",numeraire:"USDC",decimals:6,amountAtomic:"1000000000",targetDate:"2026-11-09",demo:true} as const;
it("shows clear demo labels, rounded losses, negative rerange delta, no probabilities and new-investment baseline",()=>{
  const markup=renderToStaticMarkup(createElement(LpDecisionResults,{result:buildDecision(req,"2026-10-09")}));
  expect(markup).toContain("DEMO 情境試算");expect(markup).toContain("-256.7341 USDC");expect(markup).toContain("-6.0000 USDC");expect(markup).toContain("尚未投入，沒有回本期");expect(markup).toContain("期間內未估得損益兩平");expect(markup).not.toContain("%");
});
it("keeps unavailable production metrics distinct from demo scenarios and fair values",()=>{
  const markup=renderToStaticMarkup(createElement(LpDecisionResults,{result:buildDecision({...req,demo:false},"2026-10-09")}));
  expect(markup).toContain("資料不足，無法可靠估計淨結果");expect(markup).toContain("歷史絕對淨損益");expect(markup).toContain("HODL 超額");expect(markup).toContain("可報價退出淨回收");expect(markup).toContain("unavailable");expect(markup).not.toContain("0.0000 USDC");
});

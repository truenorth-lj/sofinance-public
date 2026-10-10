import { describe, expect, it } from "vitest";
import { amountToAtomic, atomicUnits, buildDecision, costTotal, decisionRequestSchema, evaluateScenario, excessNet, exitNet, historicalNet, hodlNet, normalizeLedger, type LedgerEvent } from "./lp-decision";
const now = "2026-10-09T00:00:00.000Z";
const req = { requestId: "test", contextVersion: 1, asset: "USDC", numeraire: "USDC", amountAtomic: "1000000000", decimals: 6, targetDate: "2026-11-09", demo: true } as const;
const event = (patch: Partial<LedgerEvent> = {}): LedgerEvent => ({ id: "deposit", eventIndex: 0, chain: "solana", signature: "fixture-not-chain-proof", timestamp: now, mint: "A", amountAtomic: "1000000", decimals: 6, kind: "deposit", source: "synthetic test fixture", account: "position", role: "deposit", priceAtEvent: "100", priceSource: "synthetic", priceTimestamp: now, numeraire: "USDC", costAlreadyIncluded: false, ...patch });
describe("LP accounting contract (all fixtures synthetic)", () => {
  it("preserves atomic precision and rejects excess decimals", () => {
    expect(amountToAtomic("9007199254740993.000001")).toBe("9007199254740993000001");
    expect(atomicUnits("9007199254740993000001", 6).toFixed()).toBe("9007199254740993.000001");
    expect(() => amountToAtomic("0.0000001")).toThrow(); expect(() => amountToAtomic("-1")).toThrow();
  });
  it("counts deposits, withdrawals, distributed income and costs once; compound stays internal", () => {
    const ledger = [event(), event({id: "fees", incomeDisposition: "distributed", kind: "fee", account: "distributed", role: "distributed-income", priceAtEvent: "5"}), event({id: "compound", kind: "compound", role: "internal", priceAtEvent: null, priceSource: null}), event({id: "withdrawal", kind: "withdrawal", role: "withdrawal", priceAtEvent: "20"}), event({id: "cost", kind: "network", role: "cost", priceAtEvent: "2"}), event({id: "included", kind: "dex", role: "cost", priceAtEvent: "8", costAlreadyIncluded: true})];
    expect(historicalNet(ledger, "80", "USDC", true, true).value).toBe("3");
    expect(historicalNet(ledger, "80", "USDC", false, true).value).toBeNull();
    expect(historicalNet(ledger, "80", "USDC", true, false).value).toBeNull();
  });
  it("refuses missing event-time prices, duplicate cash flows and fictitious transfer income", () => {
    expect(historicalNet([event({ priceAtEvent: null })], "100", "USDC", true, true).status).toBe("unavailable");
    expect(normalizeLedger([event(),event()], "USDC").complete).toBe(false);
    expect(normalizeLedger([event({ kind: "transfer", role: "distributed-income", account: "distributed" })], "USDC").complete).toBe(false);
    expect(normalizeLedger([event({kind: "fee", role: "distributed-income"})], "USDC").complete).toBe(false);
  });
  it("HODL deposits at the same times and withdraws proportionally across both tokens", () => {
    const hodl = hodlNet([{ kind: "deposit", time: now, tokens: { A: "10", B: "10" }, prices: { A: "2", B: "1" } }, {kind: "withdrawal", time: "2026-10-10", tokens: { B: "20" }, prices: { A: "3", B: "1" } }], { A: "4", B: "1" });
    expect(hodl.value).toBe("15"); // remaining 5A + 5B + 20 withdrawn - 30 deposit
    expect(excessNet({status:"available",value:"10",reasons:[]},hodl).value).toBe("-5");
    expect(hodlNet([{kind:"deposit",time:now,tokens:{A:"1"},prices:{A:null}}],{A:"2"}).value).toBeNull();
  });
});
describe("read-only scenarios and data gates", () => {
  it("production cannot quietly succeed with demo or legacy pnl", () => {
    const r = buildDecision({...req,demo:false}, now);
    expect(r.status).toBe("unavailable"); expect(r.scenarios).toEqual([]);
    expect(r.historical.value).toBeNull(); expect(r.exit.value).toBeNull(); expect(r.executable).toBe(false);
    expect(decisionRequestSchema.safeParse({...req,pnlUsd:42}).success).toBe(false);
  });
  it("validates dates and supports only explicit denomination", () => {
    expect(decisionRequestSchema.safeParse({...req,targetDate:"2026-02-30"}).success).toBe(false);
    expect(decisionRequestSchema.safeParse({...req,asset:"SOL"}).success).toBe(false);
    expect(() => buildDecision({...req,targetDate:"2026-10-09"},now)).toThrow();
  });
  it("shows adverse cases, negative rerange delta, no probabilities and conditional breakeven", () => {
    const r = buildDecision({...req,positionId:"11111111111111111111111111111111"},now);
    expect(r.demo).toBe(true);
    for (const s of r.scenarios) expect(s.probability).toBeNull();
    expect(Number(r.scenarios[1]!.strategies[0]!.net.value)).toBeLessThan(0);
    expect(Number(r.scenarios[1]!.strategies[1]!.deltaVsHold.value)).toBeLessThan(0);
    expect(r.scenarios[2]!.strategies.every(s => Number(s.net.value) < 0)).toBe(true);
    expect(r.scenarios[2]!.strategies.every(s => s.breakevenDay === null)).toBe(true);
    expect(r.scenarios[0]!.strategies[0]!.breakevenDay).toBe(31);
    expect(buildDecision(req,now).scenarios[2]!.strategies[2]!.net.value).toBe("0");
  });
  it("unknown costs, zero active liquidity and risk thresholds block comparison", () => {
    const s = buildDecision(req,now).scenarios[0]!.assumptions;
    s.freshness = "stale";
    expect(evaluateScenario(s,"1000").every(r=>r.net.value===null)).toBe(true);
    s.freshness = "demo";
    s.costs.rerange[0]!.value = null;
    expect(evaluateScenario(s,"1000")[1]!.net.value).toBeNull();
    s.path[1]!.activeLiquidity = "0";
    expect(evaluateScenario(s,"1000").every(r=>r.net.value===null)).toBe(true);
    s.path[1]!.activeLiquidity = "1000000"; s.risks = ["depeg / issuer freeze / insufficient liquidity"];
    expect(evaluateScenario(s,"1000").every(r=>r.net.value===null)).toBe(true);
  });
  it("deduplicates costs, excludes sunk costs and never uses slippage tolerance as expected cost", () => {
    const costs = buildDecision(req,now).scenarios[0]!.assumptions.costs.hold;
    expect(costTotal([...costs,{...costs[0]!,period:"historical",value:"999"}]).value).toBe("2");
    expect(costTotal(costs.map(c=>({...c,included:true}))).value).toBe("0");
    expect(costTotal([...costs,costs[0]!]).value).toBeNull();
    expect(costTotal(costs.slice(1)).value).toBeNull();
    expect(exitNet({gross:"1000",expiresAt:now,source:"demo",executable:true,route:"convert",costs},now).value).toBeNull();
    expect(exitNet({gross:"1000",expiresAt:"2026-10-10",source:"demo",executable:true,route:"convert",costs},now).value).toBe("998");
  });
});

describe("review regressions: identities, clocks, exit basis and conditional policy",()=>{
  it("rejects aliases of the same economic event and fees linked to reinvestment",()=>{
    expect(normalizeLedger([event(),event({id:"alias"})],"USDC").complete).toBe(false);
    const income=event({id:"fee",kind:"fee",role:"distributed-income",account:"distributed",incomeDisposition:"distributed"});
    const compound=event({id:"reinvest",kind:"compound",role:"internal",relatedEventId:"fee"});
    expect(historicalNet([income,compound],"100","USDC",true,true).value).toBeNull();
    expect(normalizeLedger([event({timestamp:"invalid",priceTimestamp:"invalid"})],"USDC").complete).toBe(false);
  });
  it("sorts HODL flows by actual instants across timezone offsets",()=>{
    expect(hodlNet([{kind:"deposit",time:"2026-10-09T10:00:00+08:00",tokens:{A:"10"},prices:{A:"1"}},{kind:"withdrawal",time:"2026-10-09T03:00:00Z",tokens:{A:"5"},prices:{A:"1"}}],{A:"2"}).value).toBe("5");
  });
  it("uses the exact remaining horizon to UTC midnight and rejects malformed ranges without throwing",()=>{
    const result=buildDecision({...req,targetDate:"2026-10-10"},"2026-10-09T12:00:00Z");
    expect(result.scenarios[0]!.assumptions.path.at(-1)?.day).toBe(0.5);
    expect(result.scenarios[0]!.assumptions.path.at(-1)?.volumeB).toBe("5000");
    const s=result.scenarios[0]!.assumptions;s.lower="unknown";
    expect(evaluateScenario(s,"1000")[0]!.net.value).toBeNull();
  });
  it("reranges only after its condition, with cooldown, max count and each operation deducted once",()=>{
    const s=buildDecision(req,now).scenarios[0]!.assumptions;
    expect(evaluateScenario(s,"1000")[1]!.rebalances).toEqual([]);
    s.path=[{day:0,priceBPerA:"1",volumeB:"0",activeLiquidity:"1000000"},{day:1,priceBPerA:"0.7",volumeB:"0",activeLiquidity:"1000000"},{day:1.5,priceBPerA:"0.5",volumeB:"0",activeLiquidity:"1000000"},{day:3,priceBPerA:"0.4",volumeB:"0",activeLiquidity:"1000000"}];
    s.rerangePolicy!.cooldownDays=2;s.rerangePolicy!.maxRebalances=1;
    const r=evaluateScenario(s,"1000");expect(r[1]!.rebalances).toHaveLength(1);expect(r[1]!.rebalances[0]?.day).toBe(1);expect(r[1]!.rebalances[0]?.cost).toBe("6");
    s.path=s.path.slice(0,2);expect(Number(evaluateScenario(s,"1000")[1]!.deltaVsHold.value)).toBeCloseTo(-6,10);
  });
  it("exit conversion requires explicit proceeds; retained tokens continue to move with terminal price",()=>{
    const s=buildDecision({...req,positionId:"11111111111111111111111111111111"},now).scenarios[1]!.assumptions;
    s.exitBasis!.grossB="900";
    expect(evaluateScenario(s,"1000")[2]!.net.value).toBe("-101");
    s.exitBasis!.route="retain-tokens";s.exitBasis!.tokens={a:"1000",b:"0"};
    expect(evaluateScenario(s,"1000")[2]!.net.value).toBe("-301");
    delete s.exitBasis;expect(evaluateScenario(s,"1000")[2]!.net.value).toBeNull();
  });
});

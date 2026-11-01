import { describe, expect, it, vi } from "vitest";
import { METEORA_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/meteora/constants";
import { recordMeteoraDailyTvl } from "./daily-tvl.server";
import { storeRequestSchema, type RwaStore } from "@/lib/rwa-store-types";

const TSLA = "8k2c9Kiavx5pbWc2dmzhL7vFp11sLgMcKFfSueq8haAh";
const SPCX = "5pw5tNUaZJpUCnYjZ1V3gd7XkLbrb4zA9pir4LFph2mj";
const BLOCKED = "Bk1111111111111111111111111111111111111111";
const RAYDIUM = "Ray1111111111111111111111111111111111111111";
const ALLOWLISTED = METEORA_ALLOWLISTED_POOLS.map((pool) => pool.poolAddress);
const lease = { job: "rwa-apr-refresh" as const, owner: "00000000-0000-4000-8000-000000000000", epoch: 1 };

function store(savedToday: string[] = []) {
  const calls: { op: string; date?: string; data?: { date: string; rows: { poolId: string; tvlUsd: number }[] } }[] = [];
  const s = { request: async (input: (typeof calls)[number]) => {
    storeRequestSchema.parse(input); // the real store's request contract
    calls.push(input);
    if (input.op === "activePools") return [
      { pair: { poolAddress: TSLA, protocol: "meteora-dlmm" } },
      { pair: { poolAddress: SPCX, protocol: "meteora-dlmm" } },
      { pair: { poolAddress: BLOCKED, protocol: "meteora-dlmm", blocked: { reasons: ["freeze"], mints: [] } } },
      { pair: { poolAddress: RAYDIUM, protocol: "raydium-clmm" } },
    ];
    if (input.op === "meteoraTvlDay") return { pools: savedToday };
    if (input.op === "saveMeteoraTvl") return { saved: input.data!.rows.length };
    throw new Error(`unexpected op ${input.op}`);
  } } as unknown as RwaStore;
  return { s, calls };
}
const datapi = (tvl: Record<string, number | "fail">) => vi.fn(async (input: RequestInfo | URL) => {
  const id = new URL(String(input)).pathname.split("/").at(-1)!;
  const value = tvl[id];
  if (value === undefined || value === "fail") return new Response("bad gateway", { status: 502 });
  return new Response(JSON.stringify({ address: id, tvl: value }), { status: 200 });
});
// 23:30 UTC on Oct 31 is already Nov 1 in Taipei: the row is keyed by the UTC day.
const clock = () => Date.parse("2026-10-31T23:30:00Z");
const run = (s: RwaStore, fetcher: typeof fetch) => recordMeteoraDailyTvl({ store: s, lease, fetcher, clock, signal: new AbortController().signal });

describe("recordMeteoraDailyTvl (inside the APR refresh)", () => {
  it("first run of the UTC day: reads every listed Meteora pool's datapi TVL and stores it under that day", async () => {
    const { s, calls } = store();
    const tvl = Object.fromEntries([...ALLOWLISTED.map((id) => [id, 1_000]), [TSLA, 34_627.8], [SPCX, 20_743.4]]);
    const fetcher = datapi(tvl);
    const { stats, issues } = await run(s, fetcher);
    expect(issues).toEqual([]);
    const save = calls.find((call) => call.op === "saveMeteoraTvl")!;
    expect(save.data!.date).toBe("2026-10-31");
    expect(save.data!.rows.map((row) => row.poolId).sort()).toEqual([...ALLOWLISTED, TSLA, SPCX].sort());
    expect(save.data!.rows.find((row) => row.poolId === TSLA)!.tvlUsd).toBe(34_627.8);
    // Blocked and Raydium rows are not listed Meteora pools: never read.
    const read = fetcher.mock.calls.map(([url]) => String(url));
    expect(read.some((url) => url.includes(BLOCKED) || url.includes(RAYDIUM))).toBe(false);
    expect(read.every((url) => url.startsWith("https://dlmm.datapi.meteora.ag/pools/"))).toBe(true);
    expect(stats).toEqual({ date: "2026-10-31", pools: ALLOWLISTED.length + 2, alreadySaved: 0, saved: ALLOWLISTED.length + 2, failed: 0 });
  });

  it("later runs the same day read nothing when every pool has its row (idempotent)", async () => {
    const { s, calls } = store([...ALLOWLISTED, TSLA, SPCX]);
    const fetcher = datapi({});
    const { stats, issues } = await run(s, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect(calls.some((call) => call.op === "saveMeteoraTvl")).toBe(false);
    expect(issues).toEqual([]);
    expect(stats).toMatchObject({ alreadySaved: ALLOWLISTED.length + 2, saved: 0, failed: 0 });
  });

  it("a pool whose read fails is reported and left for the next run; the others are saved", async () => {
    const { s, calls } = store(ALLOWLISTED);
    const { stats, issues } = await run(s, datapi({ [TSLA]: 34_627.8, [SPCX]: "fail" }));
    expect(calls.find((call) => call.op === "saveMeteoraTvl")!.data!.rows).toEqual([{ poolId: TSLA, tvlUsd: 34_627.8 }]);
    expect(stats).toMatchObject({ saved: 1, failed: 1 });
    expect(issues).toEqual([expect.stringMatching(/^Meteora TVL: 1 of 2 pools not read for 2026-10-31 \(Upstream request failed \(502\)\); retried next run$/)]);
  });
});

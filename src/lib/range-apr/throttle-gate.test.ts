import { describe, expect, it } from "vitest";
import { ThrottleGate } from "./throttle-gate";

function clock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t, sleeps, advance: (ms: number) => { t += ms; },
    sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
  };
}

describe("ThrottleGate", () => {
  it("runs calls one at a time, in order, spaced by minSpacingMs", async () => {
    const c = clock();
    const gate = new ThrottleGate({ minSpacingMs: 250, now: c.now, sleep: c.sleep });
    const order: string[] = [];
    const task = (name: string) => async () => { order.push(`start ${name}`); await Promise.resolve(); order.push(`end ${name}`); return name; };
    const results = await Promise.all(["a", "b", "c"].map((name) => gate.run(task(name))));
    expect(results).toEqual([{ value: "a" }, { value: "b" }, { value: "c" }]);
    expect(order).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(c.sleeps).toEqual([250, 250]); // the first call starts immediately
  });

  it("refuses calls during the cooldown and reopens by itself afterwards", async () => {
    const c = clock();
    const gate = new ThrottleGate({ minSpacingMs: 0, now: c.now, sleep: c.sleep });
    gate.block(30_000);
    expect(gate.blockedForMs()).toBe(30_000);
    let ran = 0;
    expect(await gate.run(async () => ++ran)).toEqual({ blocked: 30_000 });
    expect(ran).toBe(0);
    c.advance(30_001);
    expect(gate.blockedForMs()).toBe(0);
    expect(await gate.run(async () => ++ran)).toEqual({ value: 1 });
  });

  it("clamps the cooldown and defaults it when there is no Retry-After", () => {
    const c = clock();
    const gate = new ThrottleGate({ defaultCooldownMs: 20_000, minCooldownMs: 5_000, maxCooldownMs: 60_000, now: c.now });
    gate.block();
    expect(gate.blockedForMs()).toBe(20_000);
    const small = new ThrottleGate({ minCooldownMs: 5_000, now: c.now });
    small.block(100);
    expect(small.blockedForMs()).toBe(5_000);
    const big = new ThrottleGate({ maxCooldownMs: 60_000, now: c.now });
    big.block(3_600_000);
    expect(big.blockedForMs()).toBe(60_000);
  });

  it("never shortens a running cooldown", () => {
    const c = clock();
    const gate = new ThrottleGate({ now: c.now });
    gate.block(50_000);
    gate.block(6_000);
    expect(gate.blockedForMs()).toBe(50_000);
  });

  it("keeps working after a task throws", async () => {
    const gate = new ThrottleGate({ minSpacingMs: 0 });
    await expect(gate.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await gate.run(async () => 1)).toEqual({ value: 1 });
  });
});

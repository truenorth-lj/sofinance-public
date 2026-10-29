import { describe, expect, it } from "vitest";
import fixture from "../../../packages/engine/src/fixtures/orca-pool-cbbtc-wbtc.json";
import { lpFeeFraction } from "./build-model";
import { ORCA_ECONOMICS_SOURCE, parseOrcaPoolEconomics } from "./orca-economics";

const body = () => structuredClone(fixture) as { data: Record<string, unknown> };

describe("parseOrcaPoolEconomics", () => {
  it("maps the captured Orca API v2 pool onto the range-APR economics shape (golden)", () => {
    const economics = parseOrcaPoolEconomics(body())!;
    expect(economics).toMatchObject({
      mintA: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij", mintB: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
      decimalsA: 8, decimalsB: 8, feeRate: 0.0001, protocolFeeRate: 130_000, fundFeeRate: 0,
      mintAmountA: 5.65402622, mintAmountB: 10.18536841,
    });
    expect(economics.tvlUsd).toBeCloseTo(1263790.70, 2);
    expect(economics.price).toBeCloseTo(1.00161139, 8);
    expect(economics.dayFeeApr).toBeCloseTo((207.3769011264072 / 1263790.703545199933) * 365 * 100, 6);
    expect(economics.weekFeeApr).toBeGreaterThan(0);
    expect(economics.weekVolumeUsd).toBeGreaterThan(0);
    // LPs keep 87% (Orca protocol fee 13%, no fund fee).
    expect(lpFeeFraction(economics.protocolFeeRate, economics.fundFeeRate)).toBeCloseTo(0.87, 12);
  });

  it("applies the discovery gate: non-allowlisted, warned or foreign-config pools are rejected", () => {
    const other = body(); other.data.address = "5MBpNcWTqiWy3pZX17pYfgP2ZxrSkok4naQWLj3XLDLY";
    const warned = body(); warned.data.hasWarning = true;
    const config = body(); config.data.whirlpoolsConfig = "11111111111111111111111111111111";
    for (const input of [other, warned, config]) expect(parseOrcaPoolEconomics(input)).toBeNull();
  });

  it("rejects missing balances, price or TVL and non-objects", () => {
    for (const field of ["tokenBalanceA", "tokenBalanceB", "price", "tvlUsdc"]) {
      const input = body(); delete input.data[field];
      expect(parseOrcaPoolEconomics(input), field).toBeNull();
    }
    expect(parseOrcaPoolEconomics(null)).toBeNull();
    expect(parseOrcaPoolEconomics([])).toBeNull();
    expect(parseOrcaPoolEconomics({ data: null })).toBeNull();
  });

  it("points at the Orca API v2 pool endpoint", () => {
    expect(ORCA_ECONOMICS_SOURCE.url("4v8ufj8Hj7UvFgtofQJAtzUud5xomwZfEqfCTHZ4wM72"))
      .toBe("https://api.orca.so/v2/solana/pools/4v8ufj8Hj7UvFgtofQJAtzUud5xomwZfEqfCTHZ4wM72");
  });
});

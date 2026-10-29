import { describe, expect, it, vi } from "vitest";
import fixture from "../../packages/engine/src/fixtures/orca-pool-cbbtc-wbtc.json";

vi.mock("server-only", () => ({}));
import { discoverOrcaPairs, orcaPairRow } from "./orca-pairs";
import { parseOrcaPool } from "@sofinance/engine/protocols/orca/discovery";

describe("Orca pair rows", () => {
  it("maps the captured cbBTC/WBTC pool to a read-only orca-whirlpool row (golden)", () => {
    const row = orcaPairRow(parseOrcaPool(fixture.data)!);
    expect(row).toMatchObject({ protocol: "orca-whirlpool", poolAddress: "4v8ufj8Hj7UvFgtofQJAtzUud5xomwZfEqfCTHZ4wM72",
      symbolA: "cbBTC", symbolB: "WBTC", baseSymbol: "BTC", wrapKind: "same-asset", relatedness: "allowlisted",
      feeTierBps: 1, token2022A: false, token2022B: false, freezeRisk: false, raydiumFeeApr24h: null });
    // LP-share 24h fees / TVL × 365 × 100 ≈ 5.2 %.
    expect(row.estimatedFeeAprPct).toBeCloseTo(207.3769 * 0.87 / 1263790.7035 * 365 * 100, 6);
    expect(row).toMatchSnapshot();
  });

  it("discovers via the Orca API only (no RPC, no Raydium)", async () => {
    const fetcher = vi.fn(async () => Response.json(fixture));
    const result = await discoverOrcaPairs({ fetcher: fetcher as unknown as typeof fetch, bypassCache: true });
    expect(result).toMatchObject({ protocol: "orca-whirlpool", readOnly: true });
    expect(result.pairs).toHaveLength(1);
    expect(fetcher.mock.calls.map(call => String((call as unknown[])[0]))).toEqual([
      "https://api.orca.so/v2/solana/pools/4v8ufj8Hj7UvFgtofQJAtzUud5xomwZfEqfCTHZ4wM72"]);
  });
});

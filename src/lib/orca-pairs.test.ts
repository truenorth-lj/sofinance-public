import type { Connection, PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import fixture from "../../packages/engine/src/fixtures/orca-pool-cbbtc-wbtc.json";

vi.mock("server-only", () => ({}));
import { discoverOrcaPairs, orcaPairRow } from "./orca-pairs";
import { fakeOrcaConnection } from "./range-apr/orca-chain.fixture";

const CBBTC = "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij";
const viaMultiple = (): Connection => {
  const { connection } = fakeOrcaConnection();
  return { getMultipleAccountsInfo: async (keys: PublicKey[]) => (await connection.getMultipleAccountsInfoAndContext(keys)).value } as unknown as Connection;
};
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

  it("discovers via the Orca API plus one read-only mint batch; cbBTC's on-chain freeze authority is flagged", async () => {
    const fetcher = vi.fn(async () => Response.json(fixture));
    const result = await discoverOrcaPairs({ fetcher: fetcher as unknown as typeof fetch, bypassCache: true, connection: viaMultiple() });
    expect(result).toMatchObject({ protocol: "orca-whirlpool", readOnly: true, freezeAuthoritySource: "onchain" });
    expect(result.pairs).toHaveLength(1);
    expect(fetcher.mock.calls.map(call => String((call as unknown[])[0]))).toEqual([
      "https://api.orca.so/v2/solana/pools/4v8ufj8Hj7UvFgtofQJAtzUud5xomwZfEqfCTHZ4wM72"]);
    // Same mints as the Meteora row: cbBTC still has a freeze authority, WBTC does not.
    expect(result.pairs[0]).toMatchObject({ freezeRiskA: true, freezeRiskB: false, freezeRisk: true });
  });

  it("falls back to Orca's API tags when the chain read fails", async () => {
    const fetcher = (async () => Response.json(fixture)) as typeof fetch;
    const down = { getMultipleAccountsInfo: async () => { throw new Error("rpc down"); } } as unknown as Connection;
    const result = await discoverOrcaPairs({ fetcher, bypassCache: true, connection: down });
    expect(result.freezeAuthoritySource).toBe("api-tags");
    expect(result.pairs[0]!.freezeRisk).toBe(false);
    expect(orcaPairRow(parseOrcaPool(fixture.data)!, new Map([[CBBTC, true]])).freezeRiskA).toBe(true);
  });
});

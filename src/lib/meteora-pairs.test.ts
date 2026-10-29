import type { Connection, PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import fixture from "../../packages/engine/src/fixtures/meteora-dlmm-pool-cbbtc-wbtc.json";

vi.mock("server-only", () => ({}));
import { discoverMeteoraPairs, meteoraPairRow, readMeteoraOnchainFacts } from "./meteora-pairs";
import { fakeMeteoraConnection, meteoraAccounts } from "./range-apr/meteora-chain.fixture";

const POOL = "53oyyjgybx6dH7i5aGeKfBUi3xPJQDeBkaENPri57x2H";
const CBBTC = "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij";
import { parseMeteoraPool } from "@sofinance/engine/protocols/meteora/discovery";

describe("Meteora pair rows", () => {
  it("maps the captured cbBTC/WBTC pool to a read-only meteora-dlmm row (golden)", () => {
    const row = meteoraPairRow(parseMeteoraPool(fixture)!);
    expect(row).toMatchObject({ protocol: "meteora-dlmm", poolAddress: "53oyyjgybx6dH7i5aGeKfBUi3xPJQDeBkaENPri57x2H",
      symbolA: "cbBTC", symbolB: "WBTC", baseSymbol: "BTC", wrapKind: "same-asset", relatedness: "allowlisted",
      feeTierBps: 1, feeRate: 0.0001, token2022A: false, token2022B: false, raydiumFeeApr24h: null,
      // cbBTC still has a freeze authority (Meteora reports freeze_authority_disabled=false); WBTC does not.
      freezeRiskA: true, freezeRiskB: false, freezeRisk: true });
    // LP-share 24h fees / TVL × 365 × 100 ≈ 0.42 %.
    expect(row.estimatedFeeAprPct).toBeCloseTo((4.247998606572472 - 0.35919833168257265) / 336203.47025545826 * 365 * 100, 6);
    expect(row).toMatchSnapshot();
  });

  it("discovers via the Meteora datapi plus one read-only chain batch (protocol share, freeze authority)", async () => {
    const fetcher = vi.fn(async () => Response.json(fixture));
    const { connection } = fakeMeteoraConnection();
    const getMultiple = vi.fn(connection.getMultipleAccountsInfoAndContext);
    const result = await discoverMeteoraPairs({ fetcher: fetcher as unknown as typeof fetch, bypassCache: true,
      connection: { getMultipleAccountsInfo: async (keys: PublicKey[]) => (await getMultiple(keys)).value } as unknown as Connection });
    expect(result).toMatchObject({ protocol: "meteora-dlmm", readOnly: true, onchainSource: "onchain" });
    expect(result.pairs).toHaveLength(1);
    expect(fetcher.mock.calls.map(call => String((call as unknown[])[0]))).toEqual([
      "https://dlmm.datapi.meteora.ag/pools/53oyyjgybx6dH7i5aGeKfBUi3xPJQDeBkaENPri57x2H"]);
    // On-chain protocol share is 10% (datapi says 5%): LP fees = gross × 0.9.
    expect(result.pairs[0]!.fees24hUsd).toBeCloseTo(4.247998606572472 * 0.9, 9);
    expect(result.pairs[0]!.estimatedFeeAprPct).toBeCloseTo(4.247998606572472 * 0.9 / 336203.47025545826 * 365 * 100, 6);
    expect(result.pairs[0]).toMatchObject({ freezeRiskA: true, freezeRiskB: false, freezeRisk: true });
  });

  it("falls back to the datapi when the chain read fails or fails its checks", async () => {
    const fetcher = (async () => Response.json(fixture)) as typeof fetch;
    const down = { getMultipleAccountsInfo: async () => { throw new Error("rpc down"); } } as unknown as Connection;
    const result = await discoverMeteoraPairs({ fetcher, bypassCache: true, connection: down });
    expect(result.onchainSource).toBe("datapi");
    expect(result.pairs[0]!.fees24hUsd).toBeCloseTo(4.247998606572472 - 0.35919833168257265, 9);
    expect(result.pairs[0]!.freezeRiskA).toBe(true);
    const pool = parseMeteoraPool(fixture)!;
    const wrongOwner = meteoraAccounts({ [POOL]: { ...meteoraAccounts()[POOL]!, owner: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK" } });
    const facts = await readMeteoraOnchainFacts(viaMultiple(wrongOwner), [pool]);
    expect(facts.protocolShareBps.size).toBe(0);
    expect(facts.freezeAuthority.get(CBBTC)).toBe(true);
  });

  it("takes freeze risk from chain over the datapi flag", () => {
    const pool = parseMeteoraPool(fixture)!;
    const row = meteoraPairRow(pool, { protocolShareBps: new Map(), freezeAuthority: new Map([[CBBTC, false]]) });
    expect(row.freezeRiskA).toBe(false);
  });
});

function viaMultiple(accounts: ReturnType<typeof meteoraAccounts>): Connection {
  const { connection } = fakeMeteoraConnection(accounts);
  return { getMultipleAccountsInfo: async (keys: PublicKey[]) => (await connection.getMultipleAccountsInfoAndContext(keys)).value } as unknown as Connection;
}

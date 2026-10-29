import { describe, expect, it, vi } from "vitest";
import fixture from "../../packages/engine/src/fixtures/meteora-dlmm-pool-cbbtc-wbtc.json";

vi.mock("server-only", () => ({}));
import { discoverMeteoraPairs, meteoraPairRow } from "./meteora-pairs";
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

  it("discovers via the Meteora datapi only (no RPC, no Raydium)", async () => {
    const fetcher = vi.fn(async () => Response.json(fixture));
    const result = await discoverMeteoraPairs({ fetcher: fetcher as unknown as typeof fetch, bypassCache: true });
    expect(result).toMatchObject({ protocol: "meteora-dlmm", readOnly: true });
    expect(result.pairs).toHaveLength(1);
    expect(fetcher.mock.calls.map(call => String((call as unknown[])[0]))).toEqual([
      "https://dlmm.datapi.meteora.ag/pools/53oyyjgybx6dH7i5aGeKfBUi3xPJQDeBkaENPri57x2H"]);
  });
});

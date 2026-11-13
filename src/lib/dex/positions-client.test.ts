import { describe, expect, it, vi } from "vitest";
import { dexDescriptors } from "./client";
import { fetchDexPerformance, fetchDexPositions, positionDescriptorsFor } from "./positions-client";

const descriptor = dexDescriptors.descriptorFor("meteora-dlmm")!;
const row = { key: "meteora-dlmm:P", source: descriptor.id, chain: descriptor.chain, nativeId: "P", poolId: "L", liquidity: "5",
  tokenA: { id: "A", symbol: null, decimals: 6 }, tokenB: { id: "B", symbol: null, decimals: 6 },
  range: { mode: "price", lower: 1, upper: 2, current: 1.5 }, rangeStatus: "in", native: {} };
const reply = (status: number, body?: unknown) => vi.fn(async () => (body === undefined ? new Response(null, { status }) : Response.json(body, { status })));

describe("fetchDexPositions", () => {
  it("treats only an uncoded 404 as 'this deployment does not serve the DEX'", async () => {
    await expect(fetchDexPositions(descriptor, "W", { fetch: reply(404) })).resolves.toBeNull();
    await expect(fetchDexPositions(descriptor, "W", { fetch: reply(404, { error: "Not found" }) })).resolves.toBeNull();
  });

  it("a coded 404 (POSITION_NOT_FOUND or any other code) is an error with the server's plain message", async () => {
    await expect(fetchDexPositions(descriptor, "W", { fetch: reply(404, { error: "This position belongs to another wallet.", code: "POSITION_NOT_FOUND" }) }))
      .rejects.toThrow("This position belongs to another wallet.");
    await expect(fetchDexPositions(descriptor, "W", { fetch: reply(404, { code: "UNSUPPORTED" }) })).rejects.toThrow(`${descriptor.displayName} positions could not be loaded.`);
  });

  it("surfaces a rate limit and other failures as errors", async () => {
    await expect(fetchDexPositions(descriptor, "W", { fetch: reply(429, { error: "Too many requests. Please wait a minute.", code: "RATE_LIMITED" }) }))
      .rejects.toThrow("Too many requests. Please wait a minute.");
    await expect(fetchDexPositions(descriptor, "W", { fetch: reply(502) })).rejects.toThrow(`${descriptor.displayName} positions could not be loaded.`);
  });

  it("accepts holdings as raw digit strings or null, and rejects anything else", async () => {
    const holdings = { liquidityRaw: { a: "100", b: "0" }, unclaimedFeesRaw: null };
    await expect(fetchDexPositions(descriptor, "W", { fetch: reply(200, { positions: [{ ...row, holdings }] }) })).resolves.toEqual([{ ...row, holdings }]);
    await expect(fetchDexPositions(descriptor, "W", { fetch: reply(200, { positions: [row] }) })).resolves.toEqual([row]);
    for (const bad of [{ liquidityRaw: { a: "1.5", b: "0" }, unclaimedFeesRaw: null }, { liquidityRaw: { a: 1, b: 2 }, unclaimedFeesRaw: null }, "x", null]) {
      await expect(fetchDexPositions(descriptor, "W", { fetch: reply(200, { positions: [{ ...row, holdings: bad }] }) }))
        .rejects.toThrow(`${descriptor.displayName} returned positions in an unexpected shape.`);
    }
  });
});

describe("fetchDexPerformance", () => {
  const summary = { key: "meteora-dlmm:P", depositedUsd: 10, withdrawnUsd: 0, feesClaimedUsd: 0, feesUnclaimedUsd: null, currentValueUsd: 10.5, pnlUsd: 0.5, partial: false };
  const metrics = { holdingDays: 2, depositedUsd: 10, currentEquityUsd: 10.5, liquidityUsd: 10.4, uncollectedFeesUsd: 0.1, feesEarnedUsd: 0.5, pnlUsd: 0.5,
    holdingPeriodReturnPct: 5, annualizedReturnPct: 900, feeOnlyAprPct: 900 };
  const report = { poolId: "L", mintA: "A", mintB: "B", metrics };

  it("posts the position key and returns the summary with its report", async () => {
    const fetch = reply(200, { ...summary, report });
    await expect(fetchDexPerformance(descriptor, "meteora-dlmm:P", { fetch })).resolves.toEqual({ ...summary, report });
    expect(fetch).toHaveBeenCalledWith("/api/dex/meteora-dlmm/performance", expect.objectContaining({ method: "POST", body: JSON.stringify({ positionKey: "meteora-dlmm:P" }) }));
  });

  it("turns a missing or non-numeric metric into null (drawn as \u2014, never NaN), in USD and token-equivalent metrics", async () => {
    const te = { baseSymbol: "TSLA", metrics: { deposited: 1, equity: "1.05", feeOnlyAprPct: Number.NaN } };
    const loose = { ...report, metrics: { depositedUsd: 10, pnlUsd: "0.5", feeOnlyAprPct: null }, tokenNative: { symbolA: "TSLA", tokenEquivalent: te } };
    const result = await fetchDexPerformance(descriptor, "meteora-dlmm:P", { fetch: reply(200, { ...summary, report: loose }) });
    const { metrics: m, tokenNative } = result.report!;
    expect(m.depositedUsd).toBe(10);
    for (const value of [m.pnlUsd, m.feeOnlyAprPct, m.holdingDays, m.currentEquityUsd]) expect(value).toBeNull();
    expect(tokenNative?.tokenEquivalent?.metrics).toMatchObject({ deposited: 1, equity: null, feeOnlyAprPct: null, feesEarned: null });
    expect(tokenNative?.symbolA).toBe("TSLA");
  });

  it("throws the server's plain message, or a plain fallback", async () => {
    await expect(fetchDexPerformance(descriptor, "meteora-dlmm:P", { fetch: reply(404, { error: "No Meteora position exists at that address.", code: "POSITION_NOT_FOUND" }) }))
      .rejects.toThrow("No Meteora position exists at that address.");
    await expect(fetchDexPerformance(descriptor, "meteora-dlmm:P", { fetch: reply(404) })).rejects.toThrow(`${descriptor.displayName} performance could not be loaded.`);
  });

  it("rejects another position's answer or a malformed body", async () => {
    for (const body of [{ ...summary, key: "meteora-dlmm:Q" }, { ...summary, pnlUsd: "1" }, { ...summary, partial: undefined }, { ...summary, report: { poolId: 1 } }]) {
      await expect(fetchDexPerformance(descriptor, "meteora-dlmm:P", { fetch: reply(200, body) })).rejects.toThrow(`${descriptor.displayName} returned performance in an unexpected shape.`);
    }
  });
});

describe("positionDescriptorsFor and Meteora client requests", () => {
  it("still lists Meteora for Solana wallets and never lists Orca", () => {
    const listed = positionDescriptorsFor(dexDescriptors.descriptors, "solana-wallet").map((entry) => entry.id);
    expect(listed).toContain("meteora-dlmm");
    expect(listed).not.toContain("orca-whirlpool");
    expect(listed).not.toContain("uniswap-v4-rhc");
    expect(dexDescriptors.descriptorFor("meteora-dlmm")!.ui?.listPositions).not.toBe(false);
    expect(dexDescriptors.descriptorFor("orca-whirlpool")!.ui?.listPositions).toBe(false);
    expect(dexDescriptors.descriptorFor("uniswap-v4-rhc")!.ui?.listPositions).toBe(true);
    expect(positionDescriptorsFor(dexDescriptors.descriptors, "evm-wallet").map((entry) => entry.id)).toEqual(["uniswap-v4-rhc"]);
  });

  it("Meteora positions and performance client requests are identical to before", async () => {
    const seen: { url: unknown; init: RequestInit | undefined }[] = [];
    const holdingsOk = { positions: [row] };
    const performanceBody = {
      key: "meteora-dlmm:P", depositedUsd: 0, withdrawnUsd: 0, feesClaimedUsd: 0, feesUnclaimedUsd: 0,
      currentValueUsd: 0, pnlUsd: 0, partial: false,
    };
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      seen.push({ url, init });
      return Response.json(String(url).includes("/performance") ? performanceBody : holdingsOk);
    });
    await expect(fetchDexPositions(descriptor, "W", { fetch })).resolves.toEqual([row]);
    await expect(fetchDexPerformance(descriptor, "meteora-dlmm:P", { fetch })).resolves.toMatchObject({ key: "meteora-dlmm:P", partial: false });
    expect(seen).toEqual([
      {
        url: "/api/dex/meteora-dlmm/positions",
        init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: "W" }), signal: undefined, cache: "no-store" },
      },
      {
        url: "/api/dex/meteora-dlmm/performance",
        init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ positionKey: "meteora-dlmm:P" }), signal: undefined, cache: "no-store" },
      },
    ]);
  });
});


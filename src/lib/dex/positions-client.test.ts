import { describe, expect, it, vi } from "vitest";
import { dexDescriptors } from "./client";
import { fetchDexPositions } from "./positions-client";

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

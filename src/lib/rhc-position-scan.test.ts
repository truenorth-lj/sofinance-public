import { STABLE_PAIR_HOOK } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { FAKE_ZERO_ADDRESS as ZERO, fakePosmRpc } from "@sofinance/engine/protocols/uniswap-v4/testing/fake-posm-rpc";
import { custom } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import {
  createScanClient, FAILURE_TTL_MS, FRESH_MIN_AGE_MS, REQUESTS_PER_IP_PER_MINUTE, resetRhcScanCache, RESULT_TTL_MS, rhcScanRateLimited,
  RhcScanBusyError, scanRhcPositions,
} from "./rhc-position-scan";

const USER = "0xB95b77e9429643cbaFdE865Fa2a9F687e8d21b04" as const;
const HEAD = 101_764_305n;

function setup() {
  const fake = fakePosmRpc({
    head: HEAD,
    nfts: [{ id: 4072237n, owner: USER, liquidity: 23_244_502_727_111_678_263n, hooks: STABLE_PAIR_HOOK.proxy }, { id: 4077059n, owner: null }],
    transfers: [{ id: 4072237n, from: ZERO, to: USER, block: 100_840_683n }, { id: 4077059n, from: ZERO, to: USER, block: 100_994_389n }, { id: 4077059n, from: USER, to: ZERO, block: 101_008_877n }],
  });
  const client = createScanClient(custom({ request: fake.request }, { retryCount: 0 }));
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  return { fake, client, clock, deps: { client, now: clock.now } };
}

describe("scanRhcPositions (server cache)", () => {
  beforeEach(() => resetRhcScanCache({ minSpacingMs: 0 }));
  afterEach(() => resetRhcScanCache());

  it("cold scan finds #4072237 (13 RPC calls), warm call within the TTL makes none", async () => {
    const { fake, deps, clock } = setup();
    const cold = await scanRhcPositions(USER, {}, deps);
    expect(cold.positions.map(p => p.tokenId)).toEqual(["4072237"]);
    expect(cold.positions[0]!.position?.liquidity).toBe("23244502727111678263");
    expect(cold.rpcCalls).toBe(13); // eth_blockNumber + 11 × eth_getLogs + 1 multicall
    expect(fake.calls).toHaveLength(13);
    clock.advance(RESULT_TTL_MS - 1);
    const warm = await scanRhcPositions(USER, {}, deps);
    expect(warm.rpcCalls).toBe(0);
    expect(warm.positions).toEqual(cold.positions);
    expect(fake.calls).toHaveLength(13);
  });

  it("after the TTL only scans new blocks (3 calls) and drops a position closed meanwhile", async () => {
    const { fake, deps, clock } = setup();
    await scanRhcPositions(USER, {}, deps);
    fake.head = HEAD + 500n;
    fake.nfts.set("4072237", { id: 4072237n, owner: null });
    fake.transfers.push({ id: 4072237n, from: USER, to: ZERO, block: HEAD + 10n });
    clock.advance(RESULT_TTL_MS);
    const next = await scanRhcPositions(USER, {}, deps);
    expect(next.rpcCalls).toBe(3);
    expect(next.positions).toEqual([]);
    expect(next.scannedToBlock).toBe((HEAD + 500n).toString());
  });

  it("fresh=1 rescans unless the result is younger than the minimum age", async () => {
    const { deps, clock } = setup();
    await scanRhcPositions(USER, {}, deps);
    clock.advance(FRESH_MIN_AGE_MS - 1);
    expect((await scanRhcPositions(USER, { fresh: true }, deps)).rpcCalls).toBe(0);
    clock.advance(1);
    expect((await scanRhcPositions(USER, { fresh: true }, deps)).rpcCalls).toBe(3);
  });

  it("shares one scan between concurrent requests for a wallet (any address case)", async () => {
    const { fake, deps } = setup();
    const [a, b] = await Promise.all([scanRhcPositions(USER, {}, deps), scanRhcPositions(USER.toLowerCase() as `0x${string}`, {}, deps)]);
    expect(a.positions).toEqual(b.positions);
    expect(fake.calls).toHaveLength(13);
  });

  it("remembers a failure briefly instead of hammering the RPC, then retries", async () => {
    const { fake, deps, clock } = setup();
    fake.failNext("eth_getLogs", Object.assign(new Error("upstream down"), { code: -32000 }));
    await expect(scanRhcPositions(USER, {}, deps)).rejects.toThrow();
    const after = fake.calls.length;
    await expect(scanRhcPositions(USER, {}, deps)).rejects.toThrow();
    expect(fake.calls).toHaveLength(after);
    clock.advance(FAILURE_TTL_MS);
    expect((await scanRhcPositions(USER, {}, deps)).positions).toHaveLength(1);
  });

  it("a 429 opens a cooldown: the next scan is refused as busy without calling the RPC", async () => {
    resetRhcScanCache({ minSpacingMs: 0, defaultCooldownMs: 30_000, minCooldownMs: 30_000 });
    const { fake, client } = setup();
    fake.failNext("eth_getLogs", new Error("HTTP request failed. Status: 429 Too Many Requests"));
    await expect(scanRhcPositions(USER, {}, { client })).rejects.toThrow();
    const after = fake.calls.length;
    const other = "0x1111111111111111111111111111111111111111" as const;
    await expect(scanRhcPositions(other, {}, { client })).rejects.toBeInstanceOf(RhcScanBusyError);
    expect(fake.calls).toHaveLength(after);
  });
});

describe("rhcScanRateLimited", () => {
  beforeEach(() => resetRhcScanCache());
  it("allows a burst per IP per minute, then limits, then recovers", () => {
    for (let i = 0; i < REQUESTS_PER_IP_PER_MINUTE; i++) expect(rhcScanRateLimited("1.2.3.4", 1000)).toBe(false);
    expect(rhcScanRateLimited("1.2.3.4", 1000)).toBe(true);
    expect(rhcScanRateLimited("5.6.7.8", 1000)).toBe(false);
    expect(rhcScanRateLimited("1.2.3.4", 61_001)).toBe(false);
  });
});

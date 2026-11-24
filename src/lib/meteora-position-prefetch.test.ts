import { PublicKey, type Connection } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import meteoraAccounts from "../../packages/engine/src/fixtures/meteora-positions-cbbtc-wbtc.json";

vi.mock("server-only", () => ({}));
import { prefetchMeteoraPositionAccounts, readMeteoraPositionSnapshot } from "./meteora-positions";
import { batchAccountReads } from "./portfolio/account-batch";

function fixtureConnection() {
  const store = new Map(Object.entries(meteoraAccounts.accounts as Record<string, { owner: string; data: string } | null>)
    .flatMap(([address, account]) => account ? [[address, { owner: new PublicKey(account.owner), data: Buffer.from(account.data, "base64") }] as const] : []));
  const read = (key: PublicKey) => store.get(key.toBase58()) ?? null;
  return {
    getAccountInfo: vi.fn(async (key: PublicKey) => read(key)),
    getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map(read)),
  };
}

describe("Meteora portfolio account prefetch", () => {
  it("warms every account the snapshot reads in three batched waves, so the per-position reads make no RPC call", async () => {
    const positions = meteoraAccounts.positions as string[];
    const direct = fixtureConnection();
    const expected = await Promise.all(positions.map((position) => readMeteoraPositionSnapshot(position, direct as unknown as Parameters<typeof readMeteoraPositionSnapshot>[1])));
    expect(expected.filter(Boolean).length).toBeGreaterThan(1);

    const rpc = fixtureConnection();
    const batched = batchAccountReads(rpc as unknown as Connection);
    await prefetchMeteoraPositionAccounts(positions, batched);
    expect(rpc.getMultipleAccountsInfo).toHaveBeenCalledTimes(3);
    const warmed = await Promise.all(positions.map((position) => readMeteoraPositionSnapshot(position, batched as unknown as Parameters<typeof readMeteoraPositionSnapshot>[1])));
    expect(rpc.getMultipleAccountsInfo).toHaveBeenCalledTimes(3); expect(rpc.getAccountInfo).not.toHaveBeenCalled();
    expect(warmed).toEqual(expected);
  });
  it("skips accounts that are not Meteora positions", async () => {
    const rpc = fixtureConnection();
    await prefetchMeteoraPositionAccounts([new PublicKey(Buffer.alloc(32, 9)).toBase58()], rpc as unknown as Connection);
    expect(rpc.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
  });
});

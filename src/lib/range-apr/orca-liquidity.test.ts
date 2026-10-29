import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { decodeWhirlpool } from "@sofinance/engine/protocols/orca/accounts";
import { ORCA_POOL, fakeOrcaConnection, orcaAccounts } from "./orca-chain.fixture";
import { readOrcaPoolLiquidity } from "./orca-liquidity";

const poolBytes = () => Buffer.from(orcaAccounts()[ORCA_POOL]!.data, "base64");

describe("readOrcaPoolLiquidity (captured mainnet cbBTC/WBTC accounts)", () => {
  it("reads state and the liquidity distribution around the current tick", async () => {
    const { connection, calls } = fakeOrcaConnection();
    const chain = await readOrcaPoolLiquidity(ORCA_POOL, connection);
    expect(chain).toMatchObject({
      poolId: ORCA_POOL, decimalsA: 8, decimalsB: 8, tickSpacing: 1, tickCurrent: 16,
      sqrtPriceX64: "18461595609128926554",
      state: { feeRate: 100, protocolFeeRate: 1300, liquidity: "4829409901481", slot: 462758028,
        vaultA: "Br2L7L6Vfro799PuNH7xdQPs6bZ4DGi2DMFsUX3DdUPW", vaultB: "4WBthDFFdS8mqJ3o9hoxtaEewcn7nuXpqUnQiHhJfHVQ" },
    });
    // Two reads: the Whirlpool, then mints + 8 tick arrays in one batch.
    expect(calls).toHaveLength(2);
    expect(calls[1]).toHaveLength(10);
    expect(chain.state.tickArrays.map((array) => array.startTickIndex)).toEqual([-352, -264, -176, -88, 0, 88, 176, 264]);
    expect(chain.state.tickArrays.every((array) => array.kind === "fixed")).toBe(true);
    // ±300 one-tick bins; the current bin holds exactly the pool's active liquidity.
    expect(chain.bins).toHaveLength(601);
    expect(chain.bins.find((bin) => bin.tick === 16)!.liquidity).toBe(4829409901481);
    expect(chain.bins.every((bin) => bin.liquidity >= 0)).toBe(true);
    expect(chain.bins.map((bin) => bin.liquidity)).toMatchSnapshot();
  });

  it("treats a missing tick array as having no initialised ticks", async () => {
    const { connection } = fakeOrcaConnection(orcaAccounts({ "8ExotkEhxEJS6yyrkzi4WDwKvpQNzx5tu79n256yNwjk": null }));
    const chain = await readOrcaPoolLiquidity(ORCA_POOL, connection);
    expect(chain.state.tickArrays[0]).toMatchObject({ startTickIndex: -352, kind: null, initializedTicks: 0 });
  });

  it("refuses non-allowlisted pools without any RPC call", async () => {
    const { connection, calls } = fakeOrcaConnection();
    await expect(readOrcaPoolLiquidity("5MBpNcWTqiWy3pZX17pYfgP2ZxrSkok4naQWLj3XLDLY", connection)).rejects.toThrow(/allowlisted/);
    expect(calls).toHaveLength(0);
  });

  it("rejects a pool account with the wrong owner, config or mints", async () => {
    const accounts = orcaAccounts();
    const wrongOwner = { ...accounts[ORCA_POOL]!, owner: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK" };
    await expect(readOrcaPoolLiquidity(ORCA_POOL, fakeOrcaConnection(orcaAccounts({ [ORCA_POOL]: wrongOwner })).connection))
      .rejects.toThrow(/does not exist/);
    const badConfig = poolBytes(); badConfig[8]! ^= 1;
    await expect(readOrcaPoolLiquidity(ORCA_POOL, fakeOrcaConnection(orcaAccounts({ [ORCA_POOL]: { ...accounts[ORCA_POOL]!, data: badConfig.toString("base64") } })).connection))
      .rejects.toThrow(/config mismatch/);
    const badMint = poolBytes(); badMint[101]! ^= 1;
    expect(decodeWhirlpool(badMint).tokenMintA).not.toBe(decodeWhirlpool(poolBytes()).tokenMintA);
    await expect(readOrcaPoolLiquidity(ORCA_POOL, fakeOrcaConnection(orcaAccounts({ [ORCA_POOL]: { ...accounts[ORCA_POOL]!, data: badMint.toString("base64") } })).connection))
      .rejects.toThrow(/mint mismatch/);
  });

  it("rejects a tick array that belongs to another pool or start index", async () => {
    const accounts = orcaAccounts();
    const first = "8ExotkEhxEJS6yyrkzi4WDwKvpQNzx5tu79n256yNwjk", second = "fk5a9M3xZovhjwCRJXufXSWBLJvzyVY7YdjhHTJSyzg";
    const { connection } = fakeOrcaConnection(orcaAccounts({ [first]: accounts[second]! }));
    await expect(readOrcaPoolLiquidity(ORCA_POOL, connection)).rejects.toThrow(/start index mismatch/);
    const foreign = { ...accounts[first]!, owner: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK" };
    await expect(readOrcaPoolLiquidity(ORCA_POOL, fakeOrcaConnection(orcaAccounts({ [first]: foreign })).connection)).rejects.toThrow(/owner mismatch/);
  });
});

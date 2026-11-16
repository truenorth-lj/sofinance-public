import { expect, it, vi } from "vitest";
import { buildExitModifyLiquidities } from "@sofinance/engine/protocols/uniswap-v4/tx-exit-posm";
import { PINNED_UNIVERSAL_ROUTER } from "@sofinance/engine/protocols/uniswap-v4/open-constants";
import { evmClientFor } from "./evm-client";

const client = evmClientFor("uniswap-v4-rhc");
const USER = "0x2222222222222222222222222222222222222222";

it("resolves one canonical native client and refuses retired ids and other DEXes", () => {
  expect(evmClientFor("uniswap-v4-rhc")).toBe(client);
  expect(Object.isFrozen(client)).toBe(true);
  for (const id of ["rhc-uniswap-v4", "unknown", "raydium-clmm", "orca-whirlpool", "meteora-dlmm"]) {
    expect(() => evmClientFor(id)).toThrow(/not available/i);
  }
  expect(client.positionSource.capabilities.performance.supported).toBe(false);
  expect(client.steps.openSteps(false).map(step => step.id)).toEqual(["sign", "execute"]);
  expect(client.steps.openSteps(true).map(step => step.id)).toEqual(["approve", "sign", "execute"]);
});

it("exposes the original pinned-router/sender/value checks and only the accepted wallet RPC fields", () => {
  const tx: Parameters<typeof client.open.checkExecuteTx>[0] = {
    from: USER, to: PINNED_UNIVERSAL_ROUTER.address, value: "0x0", data: "0x1234", chainId: 4663, gasLimit: "100",
  };
  expect(() => client.open.checkExecuteTx(tx, USER)).not.toThrow();
  for (const patch of [{ chainId: 1 }, { to: USER }, { from: PINNED_UNIVERSAL_ROUTER.address }, { value: "0x1" }]) {
    expect(() => client.open.checkExecuteTx({ ...tx, ...patch } as never, USER)).toThrow(client.open.TxGuardError);
  }
  expect(client.open.walletTxParams(tx)).toEqual({ from: USER, to: tx.to, data: "0x1234", value: "0x0", gas: "0x64" });
  expect(client.open.isPermitExpired("123", 123)).toBe(true);
  expect(client.exit.isDeadlinePassed("123", 123)).toBe(true);
});

it("retains calldata decoding for the exact exit NFT and read-only receipt polling through the public binding", async () => {
  const pool = client.pools[0]!;
  const built = buildExitModifyLiquidities({ pool, user: USER, tokenId: 1n, liquidity: 10n,
    amount0Min: 1n, amount1Min: 1n, nowSeconds: 1_800_000_000 });
  const tx: Parameters<typeof client.exit.checkExitTx>[0] = { from: built.from, to: built.to, data: built.data, value: "0x0", chainId: 4663 };
  expect(() => client.exit.checkExitTx(tx, USER, "1", pool)).not.toThrow();
  expect(() => client.exit.checkExitTx(tx, USER, "2", pool)).toThrow(/safety check/);
  const receipt = { status: "0x1", logs: [] }, request = vi.fn().mockResolvedValue(receipt);
  expect(await client.open.waitForReceipt({ request }, "0xhash", { intervalMs: 0, timeoutMs: 1 })).toBe(receipt);
  expect(request).toHaveBeenCalledExactlyOnceWith({ method: "eth_getTransactionReceipt", params: ["0xhash"] });
});

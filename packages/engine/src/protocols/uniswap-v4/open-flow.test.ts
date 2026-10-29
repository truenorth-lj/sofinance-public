import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import capture from "../../fixtures/univ4-rhc-open-capture.json";
import { createRhcClient, resetEvmRpcGuards } from "../../rpc-evm/index";
import { captureAccountKey, captureOverrides } from "../../test-support/rhc-open-capture";
import { replayTransport, type RpcCapture } from "../../test-support/rhc-replay";
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "./constants";
import { EVM_FEE_RECIPIENT_PLACEHOLDER, PINNED_UNIVERSAL_ROUTER, REQUOTE_CONFIRM_MESSAGE } from "./open-constants";
import { finalizeOpen, formatLeftoverPct, leftoverRefund, type OpenFlowResult, permitFromJson, prepareOpen, RETRY_FAILED_MESSAGE } from "./open-flow";
import { Q96 } from "./tick-math";
import { checkOpenPlan } from "./plan-guard";

const pool = UNIV4_RHC_ALLOWLISTED_POOLS[0]!;
const account = privateKeyToAccount(captureAccountKey());
const user = account.address;
const E18 = 10n ** 18n;

function replayDeps() {
  const misses: string[] = [];
  let t = 0;
  const client = createRhcClient("state", { env: {}, transportFor: () => replayTransport(capture as RpcCapture, misses), now: () => (t += 1_000) });
  return { deps: { client, stateOverrides: captureOverrides(user, 1000n * E18) }, misses };
}

beforeEach(() => resetEvmRpcGuards());

async function prepareAndSign(deps: ReturnType<typeof replayDeps>["deps"], req: Parameters<typeof prepareOpen>[1]) {
  const prep = await prepareOpen(deps, req);
  if (prep.state !== "needs_signature") throw new Error(`prepare: ${JSON.stringify(prep)}`);
  const permit = permitFromJson(prep.permit);
  const signature = await account.signTypedData({ ...prep.typedData, message: permit } as never);
  return { prep, permit, signature };
}

const ready = (r: OpenFlowResult) => {
  if (r.state !== "ready" && r.state !== "confirm_again") throw new Error(JSON.stringify(r));
  return r;
};

describe("open flow on recorded Robinhood Chain captures (block ~100.74M, 2026-10-29)", () => {
  it("2 SPCX into ±10 ticks: one UR execute with Permit2, fee exactly 10 bps of swap output, NFT to user", async () => {
    const { deps, misses } = replayDeps();
    const req = { pool, user, depositToken: pool.currency0.address, amount: 2n * E18, tickLower: -11, tickUpper: 9 };
    const { prep, permit, signature } = await prepareAndSign(deps, req);
    if (prep.state !== "needs_signature") throw new Error();
    expect(prep.plan).toMatchObject({ kind: "swap", priceTolBps: 0.2, slippageBps: 5, feeRecipient: EVM_FEE_RECIPIENT_PLACEHOLDER, feeRecipientIsPlaceholder: true, ticksCrossed: [] });
    expect(prep.typedData).toMatchObject({ primaryType: "PermitSingle", domain: { name: "Permit2", chainId: 4663 },
      message: { spender: PINNED_UNIVERSAL_ROUTER.address, details: { token: pool.currency0.address, amount: (2n * E18).toString() } } });
    expect(prep.simulation.checks).toMatchObject({ feeExact: true, feeOnDepositToken: "0", nftToUser: true });
    expect(prep.approvalTx).toBeNull();
    // Leftover note from the simulation's actual refunds (PM, 2026-10-29).
    const refunded = BigInt(prep.simulation.checks!.refund0 as string) + BigInt(prep.simulation.checks!.refund1 as string);
    expect(refunded > 0n).toBe(true);
    expect(prep.leftover.pctOfDeposit).toBeGreaterThan(0);
    expect(prep.leftover.pctOfDeposit).toBeLessThan(5);
    expect(prep.leftover.message.zh).toBe(`約 ${prep.leftover.display}% 無法放進區間，會在同一筆交易退回你的錢包`);
    expect(prep.leftover.message.en).toBe(`About ${prep.leftover.display}% won't fit in the range and is returned to your wallet in the same transaction`);

    const fin = ready(await finalizeOpen(deps, { ...req, permit, signature, attempt: 0 }));
    expect(fin.state).toBe("ready");
    expect(fin.tx).toMatchObject({ from: user, to: PINNED_UNIVERSAL_ROUTER.address, value: "0x0", chainId: 4663 });
    expect(BigInt(fin.gas.limit)).toBe(BigInt(fin.gas.estimate) * 12_500n / 10_000n);
    expect(fin.simulation.checks).toMatchObject({ feeExact: true, nftToUser: true, feePaid: fin.plan.fee });
    // The returned calldata passes the independent checker.
    expect(checkOpenPlan({ tx: { ...fin.tx, value: 0n }, pool, user, tokenIn: pool.currency0.address, nowSeconds: permit.details.expiration - 1800 }))
      .toMatchObject({ sequence: "swap", tickLower: -11, tickUpper: 9, permitAmount: 2n * E18 });

    // After an on-chain revert the client asks once more: same signature, PM wording.
    const again = ready(await finalizeOpen(deps, { ...req, permit, signature, attempt: 1 }));
    expect(again).toMatchObject({ state: "confirm_again", attempt: 1, message: REQUOTE_CONFIRM_MESSAGE });
    expect(again.message?.zh).toBe("價格剛變動，已重新報價，請再確認一次");
    // A second revert is not retried.
    expect(await finalizeOpen(deps, { ...req, permit, signature, attempt: 2 })).toMatchObject({ state: "failed", code: "retry-budget", message: RETRY_FAILED_MESSAGE.en });
    expect(misses).toEqual([]);
  });

  it("20 SPCXon crosses the real initialised ticks 0 and 1 (tick walk)", async () => {
    const { deps, misses } = replayDeps();
    // Burn the first scenario's recorded responses in order (FIFO per request).
    const first = { pool, user, depositToken: pool.currency0.address, amount: 2n * E18, tickLower: -11, tickUpper: 9 };
    const s1 = await prepareAndSign(deps, first);
    for (const attempt of [0, 1]) await finalizeOpen(deps, { ...first, permit: s1.permit, signature: s1.signature, attempt });
    const req = { pool, user, depositToken: pool.currency1.address, amount: 20n * E18, tickLower: -11, tickUpper: 9 };
    const { prep, permit, signature } = await prepareAndSign(deps, req);
    if (prep.state !== "needs_signature") throw new Error();
    expect(prep.plan.ticksCrossed).toEqual([0, 1]);
    const fin = ready(await finalizeOpen(deps, { ...req, permit, signature, attempt: 0 }));
    expect(fin.simulation.checks).toMatchObject({ feeExact: true, feeOnDepositToken: "0", nftToUser: true });
    expect(misses).toEqual([]);
  });

  it("rejects a wrong signer and a mismatched permit before touching the chain", async () => {
    const { deps } = replayDeps();
    const req = { pool, user, depositToken: pool.currency0.address, amount: 2n * E18, tickLower: -11, tickUpper: 9 };
    const { permit, signature } = await prepareAndSign(deps, req);
    const other = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const bad = await other.signTypedData({ domain: { name: "Permit2", chainId: 4663, verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3" },
      types: { PermitSingle: [{ name: "details", type: "PermitDetails" }, { name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }],
        PermitDetails: [{ name: "token", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }] },
      primaryType: "PermitSingle", message: permit });
    expect(await finalizeOpen(deps, { ...req, permit, signature: bad, attempt: 0 })).toMatchObject({ state: "failed", code: "signature-invalid" });
    expect(await finalizeOpen(deps, { ...req, amount: 3n * E18, permit, signature, attempt: 0 })).toMatchObject({ state: "failed", code: "permit-mismatch" });
  });
});

describe("leftover refund note", () => {
  it("values both refunded tokens in the deposit token at the post-swap price", () => {
    const E = 10n ** 18n;
    // Price 1: 1 + 1 refunded of 100 deposited = 2%.
    expect(leftoverRefund({ refund0: E, refund1: E }, { amountIn: 100n * E, sqrtPriceAfterX96: Q96 }, true)).toMatchObject({ pctOfDeposit: 2, display: "2.0" });
    // Price 4 (token1 per token0): 4 token1 = 1 token0.
    expect(leftoverRefund({ refund0: 0n, refund1: 4n * E }, { amountIn: 100n * E, sqrtPriceAfterX96: 2n * Q96 }, true).pctOfDeposit).toBe(1);
    expect(leftoverRefund({ refund0: E, refund1: 0n }, { amountIn: 100n * E, sqrtPriceAfterX96: 2n * Q96 }, false).pctOfDeposit).toBe(4);
  });
  it("formats X", () => {
    expect([0, 0.004, 0.374, 2.44, 12.06].map(formatLeftoverPct)).toEqual(["0", "<0.01", "0.37", "2.4", "12.1"]);
  });
});

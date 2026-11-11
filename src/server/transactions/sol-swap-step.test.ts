import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/engine-host", () => ({}));

const engine = vi.hoisted(() => ({ delivery: vi.fn(), spent: vi.fn(), build: vi.fn(), height: vi.fn(), feeSeen: [] as number[] }));
// In-memory fee-credit ledger with the Postgres store's semantics (insert once; compare-and-set re-claim).
const ledger = vi.hoisted(() => {
  type Claim = { swapSignature: string; wallet: string; openBlockhash: string; openLastValidBlockHeight: number };
  const rows = new Map<string, Claim & { claims: number }>();
  const state = { rows, down: false, loseRace: false };
  class SolSwapCreditStoreUnavailableError extends Error {}
  const check = () => { if (state.down) throw new SolSwapCreditStoreUnavailableError(); };
  const store = {
    claim: vi.fn(async (input: Claim) => {
      check(); const existing = rows.get(input.swapSignature);
      if (existing) return { claimed: false, existing: { ...existing } };
      rows.set(input.swapSignature, { ...input, claims: 1 }); return { claimed: true };
    }),
    reclaim: vi.fn(async (input: Claim & { previousBlockhash: string }) => {
      check(); const row = rows.get(input.swapSignature);
      if (state.loseRace || !row || row.wallet !== input.wallet || row.openBlockhash !== input.previousBlockhash) return false;
      rows.set(input.swapSignature, { ...input, claims: row.claims + 1 }); return true;
    }),
  };
  return { state, store, SolSwapCreditStoreUnavailableError };
});
vi.mock("@/lib/sol-swap-credit-store", () => ({ getSolSwapCreditStore: () => ledger.store, SolSwapCreditStoreUnavailableError: ledger.SolSwapCreditStoreUnavailableError }));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: () => ({ getBlockHeight: engine.height }) }));
vi.mock("@sofinance/engine/sol-swap-step", () => ({ readSolSwapDelivery: engine.delivery, isSolSwapCreditSpent: engine.spent, buildAndSimulateSolSwapStep: vi.fn() }));
vi.mock("@sofinance/engine/open-atomic", () => ({ buildAndSimulateOpenPosition: engine.build }));
vi.mock("@/lib/open-permit", () => ({ issueOpenPositionPermit: () => "permit" }));
vi.mock("@/lib/rpc-fee-estimate", () => ({ withFeeEstimateRetry: (fn: () => unknown) => fn() }));

import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { readSwapFeeConfig } from "@sofinance/engine/swap/fee";
import {
  assertSolSwapFeeCredit, SOL_SWAP_CREDIT_PENDING_MESSAGE, SOL_SWAP_CREDIT_UNAVAILABLE_MESSAGE, SOL_SWAP_CREDIT_USED_MESSAGE, SOL_SWAP_FEE_CREDIT_MS, SOL_SWAP_FEE_SHORT_MESSAGE, SOL_SWAP_NOT_STEP_ONE_MESSAGE,
} from "./sol-swap-step";
import { prepareOpen, SINGLE_TX_SOL_OPEN_MESSAGE } from "./open-prepare";
import { APP_OPEN_PREPARE, MCP_OPEN_PREPARE } from "./surface-policy";

const wallet = Keypair.generate().publicKey.toBase58();
const mint = Keypair.generate().publicKey.toBase58();
const outputAccount = Keypair.generate().publicKey.toBase58();
const signature = bs58.encode(new Uint8Array(64).fill(7));
const now = 1_800_000_000_000;
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const delivered = (over: Record<string, unknown> = {}) => ({
  status: "confirmed", delivered: "24650000", decimals: 9, blockTime: now / 1000 - 60, feeAccountPaid: true, feeCheck: "ok", slot: 462750173,
  outputAccounts: [outputAccount], programIds: [COMPUTE_BUDGET, JUPITER], ...over,
});
/** Blockhash of the n-th built open (valid base58, distinct per build). */
const blockhashOf = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
let warn: { mock: { calls: unknown[][] }; mockRestore: () => void };
type Refusal = { reason: string; feeCheck: string | null; wallet: string; swap: string; programs: string[] };
const refusals = (): Refusal[] => warn.mock.calls.filter((call) => call[0] === "[sol-swap-credit-refused]").map((call) => JSON.parse(String(call[1])) as Refusal);

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  vi.stubEnv("SOFINANCE_FEE_WALLET", Keypair.generate().publicKey.toBase58());
  vi.stubEnv("SOFINANCE_FEE_BPS", "10");
  engine.delivery.mockReset().mockResolvedValue(delivered());
  engine.spent.mockReset().mockResolvedValue(false);
  engine.feeSeen = [];
  engine.height.mockReset().mockResolvedValue(1_000);
  ledger.state.rows.clear(); ledger.state.down = false; ledger.state.loseRace = false;
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  engine.build.mockReset().mockImplementation(async () => {
    engine.feeSeen.push(readSwapFeeConfig().bps);
    const n = engine.build.mock.calls.length;
    return { summary: { ok: true, blockhash: blockhashOf(n), lastValidBlockHeight: 1_150 }, transaction: { message: { serialize: () => new Uint8Array([1]) }, serialize: () => new Uint8Array([2]) } };
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); warn.mockRestore(); });

describe("assertSolSwapFeeCredit", () => {
  it("accepts a recent confirmed fee-paying swap that delivered at least the open amount", async () => {
    await expect(assertSolSwapFeeCredit(wallet, signature, mint, "0.02465")).resolves.toEqual({
      slot: 462750173, outputAccounts: [outputAccount], programIds: [COMPUTE_BUDGET, JUPITER] });
    expect(refusals()).toEqual([]);
    expect(engine.delivery).toHaveBeenCalledWith({ signature, wallet, outputMint: mint });
    expect(engine.spent).toHaveBeenCalledWith({ signature, wallet, outputMint: mint, outputAccounts: [outputAccount] });
  });
  it("rejects a reused swap: its tokens were already deposited (or moved) after the swap", async () => {
    engine.spent.mockResolvedValue(true);
    await expect(assertSolSwapFeeCredit(wallet, signature, mint, "0.02465")).rejects.toThrow(SOL_SWAP_CREDIT_USED_MESSAGE);
  });
  it("rejects a missing or short protocol fee before reading any later history", async () => {
    engine.delivery.mockResolvedValue(delivered({ feeAccountPaid: false, feeCheck: "fee_short" }));
    await expect(assertSolSwapFeeCredit(wallet, signature, mint, "0.02465")).rejects.toThrow(SOL_SWAP_FEE_SHORT_MESSAGE);
    expect(engine.spent).not.toHaveBeenCalled();
  });
  it("rejects a transaction that is not a server-built step-1 SOL swap (dust, non-SOL input, extra transfers)", async () => {
    engine.delivery.mockResolvedValue(delivered({ feeAccountPaid: false, feeCheck: "not_sol_swap" }));
    await expect(assertSolSwapFeeCredit(wallet, signature, mint, "0.02465")).rejects.toThrow(SOL_SWAP_NOT_STEP_ONE_MESSAGE);
    expect(engine.spent).not.toHaveBeenCalled();
  });
  it.each([
    ["unconfirmed", { status: "pending" }, "not confirmed"],
    ["fee not paid", { feeAccountPaid: false, feeCheck: "fee_short" }, "did not pay the full protocol fee"],
    ["too old", { blockTime: (now - SOL_SWAP_FEE_CREDIT_MS - 1000) / 1000 }, "too old"],
    ["over-claimed", { delivered: "24649999" }, "exceeds what the step 1/2 swap delivered"],
  ])("rejects %s", async (_name, over, message) => {
    engine.delivery.mockResolvedValue(delivered(over));
    await expect(assertSolSwapFeeCredit(wallet, signature, mint, "0.02465")).rejects.toThrow(message);
  });
  it("logs every refusal with its reason, the fee check and the swap's program ids, never a full address", async () => {
    engine.delivery.mockResolvedValue(delivered({ feeAccountPaid: false, feeCheck: "not_sol_swap" }));
    await expect(assertSolSwapFeeCredit(wallet, signature, mint, "0.02465")).rejects.toThrow(SOL_SWAP_NOT_STEP_ONE_MESSAGE);
    expect(refusals()).toEqual([{ reason: "not_sol_swap", feeCheck: "not_sol_swap",
      wallet: `${wallet.slice(0, 4)}…${wallet.slice(-4)}`, swap: `${signature.slice(0, 4)}…${signature.slice(-4)}`,
      programs: ["Comp…1111", "JUP6…TaV4"] }]);
    const line = String(warn.mock.calls[0]?.[1]);
    for (const full of [wallet, signature, JUPITER, COMPUTE_BUDGET]) expect(line).not.toContain(full);
  });
  it("rejects a malformed signature without touching RPC", async () => {
    await expect(assertSolSwapFeeCredit(wallet, "abc", mint, "1")).rejects.toThrow("Invalid step-1 swap signature");
    expect(engine.delivery).not.toHaveBeenCalled();
    expect(refusals()).toMatchObject([{ reason: "invalid_signature", feeCheck: null, programs: [] }]);
  });
});

describe("prepareOpen with SOL", () => {
  const command = (over: Record<string, unknown> = {}) => ({
    wallet, poolId: "pool", selection: { inputMint: mint, inputKind: "token" as const }, amount: "0.02465",
    range: { preset: "standard" }, floorBps: 0, nftMint: "nft", ...over,
  }) as unknown as Parameters<typeof prepareOpen>[0];

  it("refuses single-transaction native SOL opens for the app and MCP", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const native = command({ selection: { inputMint: "So11111111111111111111111111111111111111112", inputKind: "native" } });
    for (const profile of [APP_OPEN_PREPARE, MCP_OPEN_PREPARE] as const) {
      await expect(prepareOpen(native, () => "secret", profile)).rejects.toThrow(SINGLE_TX_SOL_OPEN_MESSAGE);
    }
    expect(engine.build).not.toHaveBeenCalled();
  });
  it("charges the normal token fee without a step-1 signature", async () => {
    await prepareOpen(command(), () => "secret", APP_OPEN_PREPARE);
    expect(engine.feeSeen).toEqual([10]);
    expect(engine.delivery).not.toHaveBeenCalled();
  });
  it("waives the fee for step 2/2 only after the step-1 swap is verified", async () => {
    await prepareOpen(command({ solSwapSignature: signature }), () => "secret", APP_OPEN_PREPARE);
    expect(engine.feeSeen).toEqual([0]);
    expect(readSwapFeeConfig().bps).toBe(10);
    // Step 2's pre-simulation snapshot must not predate the step-1 swap it deposits.
    expect(engine.build.mock.calls[0]?.[6]).toMatchObject({ minContextSlot: 462750173 });
  });
  it("does not pin a snapshot slot for a plain token open", async () => {
    await prepareOpen(command(), () => "secret", APP_OPEN_PREPARE);
    expect(engine.build.mock.calls[0]?.[6]).not.toHaveProperty("minContextSlot");
  });
  it("does not build when the step-1 swap check fails", async () => {
    engine.delivery.mockResolvedValue(delivered({ feeAccountPaid: false }));
    await expect(prepareOpen(command({ solSwapSignature: signature }), () => "secret", APP_OPEN_PREPARE)).rejects.toThrow("protocol fee");
    expect(engine.build).not.toHaveBeenCalled();
  });
  it("does not build (no fee-free open) when the step-1 swap was already used", async () => {
    engine.spent.mockResolvedValue(true);
    await expect(prepareOpen(command({ solSwapSignature: signature }), () => "secret", APP_OPEN_PREPARE)).rejects.toThrow(SOL_SWAP_CREDIT_USED_MESSAGE);
    expect(engine.build).not.toHaveBeenCalled();
  });
  it("ignores a step-1 signature on the MCP surface (fee still charged)", async () => {
    await prepareOpen(command({ solSwapSignature: signature }), () => "secret", MCP_OPEN_PREPARE);
    expect(engine.feeSeen).toEqual([10]);
  });

  describe("single-use fee credit (used-signature ledger)", () => {
    const step2 = () => prepareOpen(command({ solSwapSignature: signature }), () => "secret", APP_OPEN_PREPARE);

    it("records the swap against the prepared open's blockhash", async () => {
      await step2();
      expect([...ledger.state.rows.values()]).toEqual([{ swapSignature: signature, wallet, openBlockhash: blockhashOf(1), openLastValidBlockHeight: 1_150, claims: 1 }]);
    });
    it("refuses a second fee-free open while the first can still land (closes the blockhash-window race)", async () => {
      const results = await Promise.allSettled([step2(), step2()]);
      expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason.message).toBe(SOL_SWAP_CREDIT_PENDING_MESSAGE);
      engine.height.mockResolvedValue(1_150);
      await expect(step2()).rejects.toThrow(SOL_SWAP_CREDIT_PENDING_MESSAGE);
      expect(refusals().map((entry) => entry.reason)).toEqual(["pending_open", "pending_open"]);
    });
    it("allows a retry once the earlier open expired without moving the swap's tokens", async () => {
      await step2();
      engine.height.mockResolvedValue(1_151);
      await expect(step2()).resolves.toBeDefined();
      expect(ledger.state.rows.get(signature)).toMatchObject({ openBlockhash: blockhashOf(2), claims: 2 });
      // The chain is re-read after expiry: the first open might have landed just before it expired.
      expect(engine.spent).toHaveBeenCalledTimes(3);
    });
    it("refuses the retry when the expired open landed after all (tokens moved)", async () => {
      await step2();
      engine.height.mockResolvedValue(1_151);
      engine.spent.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      await expect(step2()).rejects.toThrow(SOL_SWAP_CREDIT_USED_MESSAGE);
      expect(ledger.state.rows.get(signature)).toMatchObject({ openBlockhash: blockhashOf(1), claims: 1 });
    });
    it("refuses when a concurrent retry moved the claim first (compare-and-set lost)", async () => {
      await step2();
      engine.height.mockResolvedValue(1_151);
      ledger.state.loseRace = true;
      await expect(step2()).rejects.toThrow(SOL_SWAP_CREDIT_PENDING_MESSAGE);
    });
    it("refuses a swap already claimed by another wallet", async () => {
      ledger.state.rows.set(signature, { swapSignature: signature, wallet: Keypair.generate().publicKey.toBase58(), openBlockhash: blockhashOf(9), openLastValidBlockHeight: 1, claims: 1 });
      await expect(step2()).rejects.toThrow(SOL_SWAP_CREDIT_USED_MESSAGE);
      expect(refusals().map((entry) => entry.reason)).toEqual(["other_wallet"]);
    });
    it("fails closed when the ledger is unavailable: no fee-free transaction is returned", async () => {
      ledger.state.down = true;
      await expect(step2()).rejects.toThrow(SOL_SWAP_CREDIT_UNAVAILABLE_MESSAGE);
      expect(refusals()).toMatchObject([{ reason: "store_unavailable", programs: ["Comp…1111", "JUP6…TaV4"] }]);
    });
    it("does not touch the ledger for a normal token open or on the MCP surface", async () => {
      await prepareOpen(command(), () => "secret", APP_OPEN_PREPARE);
      await prepareOpen(command({ solSwapSignature: signature }), () => "secret", MCP_OPEN_PREPARE);
      expect(ledger.store.claim).not.toHaveBeenCalled();
    });
  });
});

import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { ENTRY_PRICE_SIGNATURE_LIMIT, lookupDepositEntryPrice, MAX_ENTRY_PRICE_TRANSACTIONS, type EntryPriceRpc, type PoolSignature } from "./stock-entry-price-lookup";
import type { RawPoolTransaction } from "./stock-entry-price-trades";
import { stockReferencePool } from "./stock-reference-pools";

const SPCX = "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** The SPCX deposit of 2026-11-03 12:27:51 UTC. */
const DEPOSIT = { signature: "D".repeat(64), blockTime: 1_793_708_871 };
const ref = stockReferencePool(SPCX)!;

const sig = (label: string, n: number) => `${label}${n}`.padEnd(64, "1");

const crank = (blockTime: number): RawPoolTransaction => ({
  blockTime,
  transaction: { message: { accountKeys: ["payer".padEnd(32, "1"), ref.pool].map((pubkey) => ({ pubkey })) } },
  meta: { err: null, preTokenBalances: [], postTokenBalances: [] },
});

function swap(blockTime: number, usdcSize: number, priceUsd: number): RawPoolTransaction {
  const stockRaw = Math.round(usdcSize / priceUsd * 1e6);
  const usdcRaw = Math.round(usdcSize * 1e6);
  const keys = ["payer".padEnd(32, "1"), ref.stockVault, ref.usdcVault];
  return {
    blockTime,
    transaction: { message: { accountKeys: keys.map((pubkey) => ({ pubkey })) } },
    meta: {
      err: null,
      preTokenBalances: [
        { accountIndex: 1, mint: ref.mint, uiTokenAmount: { amount: String(20_000_000 + stockRaw), decimals: 6 } },
        { accountIndex: 2, mint: USDC, uiTokenAmount: { amount: "100000000000", decimals: 6 } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: ref.mint, uiTokenAmount: { amount: "20000000", decimals: 6 } },
        { accountIndex: 2, mint: USDC, uiTokenAmount: { amount: String(100_000_000_000 + usdcRaw), decimals: 6 } },
      ],
    },
  };
}

const dust = (blockTime: number): RawPoolTransaction => swap(blockTime, 0.26, 136.81);

const lpAdd = (blockTime: number): RawPoolTransaction => {
  const keys = ["payer".padEnd(32, "1"), ref.stockVault, ref.usdcVault];
  return {
    blockTime,
    transaction: { message: { accountKeys: keys.map((pubkey) => ({ pubkey })) } },
    meta: {
      err: null,
      preTokenBalances: [
        { accountIndex: 1, mint: ref.mint, uiTokenAmount: { amount: "20000000", decimals: 6 } },
        { accountIndex: 2, mint: USDC, uiTokenAmount: { amount: "100000000000", decimals: 6 } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: ref.mint, uiTokenAmount: { amount: "20140015", decimals: 6 } },
        { accountIndex: 2, mint: USDC, uiTokenAmount: { amount: "100030234176", decimals: 6 } },
      ],
    },
  };
};

type Item = { signature: string; blockTime: number; err?: unknown; tx: RawPoolTransaction | null };

function rpcFrom(items: readonly Item[]) {
  const calls: string[] = [];
  const rpc: EntryPriceRpc = {
    async signaturesBefore(_pool, _before, limit) {
      calls.push(`signatures:${limit}`);
      return items.slice(0, limit).map(({ signature, blockTime, err }) => ({ signature, blockTime, err: err ?? null }) satisfies PoolSignature);
    },
    async transaction(signature) {
      calls.push(`transaction:${signature}`);
      return items.find((item) => item.signature === signature)?.tx ?? null;
    },
  };
  return { rpc, calls };
}

/** 12 leading signatures with no qualifying trade (RefreshPriceList cranks, a failed tx, an LP add, $0.26 dust), then the real swaps just past that page. */
function spcxHour(): Item[] {
  const age = (seconds: number) => DEPOSIT.blockTime - seconds;
  const cranks: Item[] = [29, 94, 100, 158, 163, 221, 284, 343, 347, 365, 410, 473].map((seconds, index) => ({
    signature: sig("crank", index), blockTime: age(seconds),
    err: index === 2 ? { InstructionError: [1, { Custom: 1 }] } : null,
    tx: index === 2 ? null : index === 5 ? lpAdd(age(seconds)) : index === 11 ? dust(age(seconds)) : crank(age(seconds)),
  }));
  const swaps: Item[] = [
    { signature: sig("swap", 0), blockTime: age(601), tx: swap(age(601), 29.458324, 136.81) },
    { signature: sig("swap", 1), blockTime: age(821), tx: swap(age(821), 8.754068, 136.81) },
    { signature: sig("swap", 2), blockTime: age(907), tx: swap(age(907), 9.240425, 137.50) },
  ];
  return [...cranks, ...swaps];
}

describe("lookupDepositEntryPrice paging", () => {
  it("asks for up to 1000 signatures once, then reads transactions in groups of 4", async () => {
    const { rpc, calls } = rpcFrom(spcxHour());
    await lookupDepositEntryPrice(rpc, ref, DEPOSIT);
    expect(calls[0]).toBe(`signatures:${ENTRY_PRICE_SIGNATURE_LIMIT}`);
    expect(calls.filter((call) => call.startsWith("transaction:")).length).toBeGreaterThan(12);
  });

  it("resolves the crank-heavy SPCX hour: RefreshPriceList noise fills the first 12 signatures, then the ~$136.81 swaps just past that", async () => {
    const { rpc, calls } = rpcFrom(spcxHour());
    const result = await lookupDepositEntryPrice(rpc, ref, DEPOSIT);
    expect(result.status).toBe("ok");
    expect(result.priceUsd).toBeCloseTo(136.81, 2);
    expect(result.trades).toHaveLength(3);
    // The first 12 include a failed signature that is not fetched, plus 11 non-trades, then the three swaps.
    expect(calls.filter((call) => call.startsWith("transaction:")).length).toBe(11 + 3);
    expect(result.rpcCalls).toBe(1 + 11 + 3);
  });

  it("stores no_trade when the 40-transaction cap is hit with 0 trades", async () => {
    const items: Item[] = Array.from({ length: MAX_ENTRY_PRICE_TRANSACTIONS + 10 }, (_, index) => ({
      signature: sig("cap0", index), blockTime: DEPOSIT.blockTime - 10 - index, tx: crank(DEPOSIT.blockTime - 10 - index),
    }));
    const { rpc, calls } = rpcFrom(items);
    const result = await lookupDepositEntryPrice(rpc, ref, DEPOSIT);
    expect(result).toMatchObject({ status: "no_trade", priceUsd: null, trades: [] });
    expect(calls.filter((call) => call.startsWith("transaction:")).length).toBe(MAX_ENTRY_PRICE_TRANSACTIONS);
    expect(result.rpcCalls).toBe(1 + MAX_ENTRY_PRICE_TRANSACTIONS);
  });

  it("keeps 1–2 trades as ok when the 40-transaction cap is hit", async () => {
    const items: Item[] = Array.from({ length: MAX_ENTRY_PRICE_TRANSACTIONS + 10 }, (_, index) => {
      const blockTime = DEPOSIT.blockTime - 10 - index;
      const isSwap = index === 0 || index === 37;
      return { signature: sig("cap2", index), blockTime, tx: isSwap ? swap(blockTime, 10, 136.81) : crank(blockTime) };
    });
    const { rpc, calls } = rpcFrom(items);
    const result = await lookupDepositEntryPrice(rpc, ref, DEPOSIT);
    expect(result.status).toBe("ok");
    expect(result.trades).toHaveLength(2);
    expect(result.priceUsd).toBeCloseTo(136.81, 2);
    expect(calls.filter((call) => call.startsWith("transaction:")).length).toBe(MAX_ENTRY_PRICE_TRANSACTIONS);
  });

  it("records no_trade for a truly empty hour, after only the signatures call", async () => {
    const { rpc, calls } = rpcFrom([
      { signature: sig("old", 0), blockTime: DEPOSIT.blockTime - 3_700, tx: swap(DEPOSIT.blockTime - 3_700, 20, 136.81) },
    ]);
    const result = await lookupDepositEntryPrice(rpc, ref, DEPOSIT);
    expect(result).toMatchObject({ status: "no_trade", priceUsd: null, rpcCalls: 1 });
    expect(calls).toEqual([`signatures:${ENTRY_PRICE_SIGNATURE_LIMIT}`]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { insertOpenSql, logPositionOpenBestEffort, persistPositionOpen, resetOpensClientForTests } from "./persist";
import { OPENS_DDL_STATEMENTS } from "./schema";
import { positionOpenRowFromSummary } from "./row";
import { openSummaryFixture, testKeypair } from "@/lib/test-support/send-fixtures";
import { USDC_MINT } from "@sofinance/engine/ids";
import type { OpenPositionSummary } from "@sofinance/engine/open-types";

const wallet = testKeypair(1).publicKey.toBase58();
const nftMint = testKeypair(2).publicKey.toBase58();

afterEach(() => {
  vi.unstubAllEnvs();
  resetOpensClientForTests();
});

function row(overrides: Record<string, unknown> = {}) {
  const summary = {
    ...openSummaryFixture({ wallet, nftMint, blockhash: "11111111111111111111111111111111" }),
    quote: {
      ...openSummaryFixture({ wallet, nftMint, blockhash: "11111111111111111111111111111111" }).quote,
      inputMint: USDC_MINT, inputDecimals: 6, requested: "2500000", symbolA: "HOODx", symbolB: "HOOD",
    },
  } as unknown as OpenPositionSummary;
  return positionOpenRowFromSummary({
    signature: "5".repeat(64), wallet, summary, sourceRef: "x-launch", ...overrides,
  })!;
}

describe("opens persist", () => {
  it("is a complete no-op when SOFINANCE_OPENS_DATABASE_URL is unset", async () => {
    vi.stubEnv("SOFINANCE_OPENS_DATABASE_URL", undefined);
    expect(await persistPositionOpen(row())).toEqual({ skipped: true, inserted: false });
    logPositionOpenBestEffort(row());
  });

  it("applies idempotent DDL then inserts ON CONFLICT DO NOTHING by tx signature", async () => {
    vi.stubEnv("SOFINANCE_OPENS_DATABASE_URL", "postgres://opens@localhost/opens");
    const sql = { unsafe: vi.fn<(query: string, params?: unknown[]) => Promise<undefined>>(async () => undefined) };
    const first = row();
    await persistPositionOpen(first, sql);
    await persistPositionOpen(first, sql);
    expect(sql.unsafe.mock.calls.map((call) => call[0])).toEqual([
      ...OPENS_DDL_STATEMENTS,
      insertOpenSql(first).sql,
      insertOpenSql(first).sql,
    ]);
    expect(insertOpenSql(first).sql).toMatch(/ON CONFLICT \(tx_signature\) DO NOTHING/);
    expect(insertOpenSql(first).params[0]).toBe(first.txSignature);
  });

  it("builds a row from a confirmed open summary, including USDC notional and sanitized ref", () => {
    const built = row();
    expect(built.sourceRef).toBe("x-launch");
    expect(built.notionalUsd).toBe(2.5);
    expect(built.symbolA).toBe("HOODx");
    expect(positionOpenRowFromSummary({
      signature: "nope", wallet, summary: openSummaryFixture({ wallet, nftMint, blockhash: "1".repeat(32) }) as never,
    })).toBeNull();
  });
});

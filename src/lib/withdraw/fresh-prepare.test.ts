import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { VersionedTransaction } from "@solana/web3.js";
import { refreshWithdrawBlockhash } from "./fresh-prepare";
import { withdrawPermit } from "@sofinance/engine/withdraw/permit";
import { BLOCKHASH, SIGNING_SECRET, buildTransaction, testKeypair, toBase64 } from "../test-support/send-fixtures";

const payer = testKeypair(1);
const transaction = buildTransaction({ payer });
const fresh = testKeypair(9).publicKey.toBase58();

beforeEach(() => {
  vi.stubEnv("JUPITER_API_KEY", SIGNING_SECRET);
});

it("restamps the blockhash and re-issues the permit without changing instructions", async () => {
  const summary = {
    operation: "withdraw" as const, wallet: payer.publicKey.toBase58(), stage: "atomic",
    expiresAt: Date.now() + 10_000, lastValidBlockHeight: 100, blockhash: BLOCKHASH,
  };
  const prepared = {
    summary, unsignedTransaction: toBase64(transaction),
    permit: withdrawPermit.issue(SIGNING_SECRET, {
      wallet: summary.wallet, message: Buffer.from(transaction.message.serialize()).toString("base64"), summary,
    }),
  };
  const connection = {
    getLatestBlockhash: vi.fn(async () => ({ blockhash: fresh, lastValidBlockHeight: 250 })),
    getAddressLookupTable: vi.fn(),
  };
  const next = await refreshWithdrawBlockhash(connection as never, prepared as never);
  const restamped = VersionedTransaction.deserialize(Buffer.from(next.unsignedTransaction, "base64"));
  expect(restamped.message.recentBlockhash).toBe(fresh);
  expect(next.summary.blockhash).toBe(fresh);
  expect(next.summary.lastValidBlockHeight).toBe(250);
  expect(next.summary.expiresAt).toBeGreaterThan(prepared.summary.expiresAt);
  expect(withdrawPermit.verify(SIGNING_SECRET, {
    wallet: summary.wallet, message: Buffer.from(restamped.message.serialize()).toString("base64"), summary: next.summary,
  }, next.permit)).toBe(true);
});

it("leaves an unparseable payload alone", async () => {
  const prepared = { summary: { wallet: "w" }, unsignedTransaction: "tx", permit: "p" };
  expect(await refreshWithdrawBlockhash({} as never, prepared as never)).toEqual(prepared);
});
